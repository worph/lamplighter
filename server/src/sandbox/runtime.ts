import { PassThrough, type Readable } from 'node:stream'
import Docker from 'dockerode'
import tar from 'tar-stream'

/**
 * The Docker API as the sandbox needs it, through docker-socket-proxy (architecture §10.1).
 * Lamplighter never holds the socket itself: `docker_url` points at the proxy, or at a socket in
 * development. Nothing here knows about repositories; sandbox/workspace.ts does.
 */

/** Docker unreachable, an image that cannot be pulled, a container that will not start: infra, not the repo (invariant 6). */
export class SandboxError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'image' | 'container',
  ) {
    super(message)
  }
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
  /** stdout and stderr interleaved as they arrived, capped head + tail. */
  output: string
  timedOut: boolean
}

export interface ExecOpts {
  cwd?: string
  timeoutMs?: number
  /** Cap on each captured stream; the middle is dropped and marked. */
  maxBytes?: number
  input?: Buffer
}

/** Docker's exit codes for `timeout` (124) and SIGKILL (137). */
const TIMEOUT_CODES = new Set([124, 137])
const GRACE_MS = 15_000
/** Time allowed for a one-off helper container (runToEnd) unless the caller says otherwise. */
const HELPER_TIMEOUT_MS = 120_000
/** Output kept from an exec unless the caller sets maxBytes. */
const EXEC_MAX_BYTES = 1_000_000

/** Keep the first and last half of a stream, so a long log shows both how it started and how it ended. */
class Capped {
  private head: Buffer[] = []
  private headLen = 0
  private tail: Buffer[] = []
  private tailLen = 0
  private dropped = 0
  constructor(private readonly max: number) {}
  push(b: Buffer) {
    const half = Math.floor(this.max / 2)
    if (this.headLen < half) {
      const take = b.subarray(0, half - this.headLen)
      this.head.push(take)
      this.headLen += take.length
      b = b.subarray(take.length)
    }
    if (!b.length) return
    this.tail.push(b)
    this.tailLen += b.length
    while (this.tailLen > half && this.tail.length) {
      const first = this.tail[0]!
      const over = this.tailLen - half
      if (first.length <= over) {
        this.tail.shift()
        this.tailLen -= first.length
        this.dropped += first.length
      } else {
        this.tail[0] = first.subarray(over)
        this.tailLen -= over
        this.dropped += over
      }
    }
  }
  toString(): string {
    const head = Buffer.concat(this.head).toString('utf8')
    const tail = Buffer.concat(this.tail).toString('utf8')
    return this.dropped ? `${head}\n… ${this.dropped} bytes cut …\n${tail}` : head + tail
  }
}

function connect(url: string): Docker {
  if (url.startsWith('unix://')) return new Docker({ socketPath: url.slice('unix://'.length) })
  let u: URL
  try {
    u = new URL(url.replace(/^tcp:/, 'http:'))
  } catch {
    throw new SandboxError(`not a Docker URL: "${url}" (tcp://host:port or unix:///path)`, 'unreachable')
  }
  return new Docker({ host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 2376 : 2375)), protocol: u.protocol === 'https:' ? 'https' : 'http' })
}

function statusOf(err: unknown): number | undefined {
  return (err as { statusCode?: number }).statusCode
}

/** Wrap a Docker call: a connection failure becomes an infra error, anything else passes through. */
async function api<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (statusOf(err) === undefined) throw new SandboxError(`Docker unreachable (${what}): ${(err as Error).message}`, 'unreachable')
    throw err
  }
}

export interface TarEntry {
  name: string
  content?: Buffer
  type?: 'file' | 'directory'
  mode?: number
}

/** A tar owned by `uid`: `docker cp` keeps the source owner, and with every capability dropped the sandbox user could not write anything else. */
export function packTar(entries: TarEntry[], uid: number): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  const done = new Promise<Buffer>((resolve, reject) => {
    pack.on('data', (c) => chunks.push(c as Buffer))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
  })
  for (const e of entries) {
    const type = e.type ?? 'file'
    const header = { name: e.name, type, mode: e.mode ?? (type === 'directory' ? 0o755 : 0o644), uid, gid: uid, mtime: new Date() }
    if (type === 'file') pack.entry(header, e.content ?? Buffer.alloc(0))
    else pack.entry(header)
  }
  pack.finalize()
  return done
}

/** The first entry of a tar stream, or null when it is not a regular file. */
export function firstFile(stream: Readable, maxBytes: number): Promise<{ name: string; content: Buffer } | null> {
  return new Promise((resolve, reject) => {
    const extract = tar.extract()
    let result: { name: string; content: Buffer } | null = null
    let seen = false
    extract.on('entry', (header, body, next) => {
      if (seen || header.type !== 'file') {
        seen = true
        body.resume()
        body.on('end', next)
        return
      }
      seen = true
      const parts: Buffer[] = []
      let len = 0
      body.on('data', (c) => {
        const b = c as Buffer
        len += b.length
        if (len <= maxBytes) parts.push(b)
      })
      body.on('end', () => {
        if (len > maxBytes) return reject(new Error(`file larger than ${maxBytes} bytes`))
        result = { name: header.name, content: Buffer.concat(parts) }
        next()
      })
    })
    extract.on('finish', () => resolve(result))
    extract.on('error', reject)
    stream.pipe(extract)
  })
}

/** Split Docker's multiplexed log stream (8-byte frame headers: stream, 3 zero bytes, length). */
export function demux(raw: Buffer): { stdout: string; stderr: string } {
  const out: Buffer[] = []
  const err: Buffer[] = []
  let i = 0
  while (i + 8 <= raw.length) {
    const kind = raw[i]!
    const len = raw.readUInt32BE(i + 4)
    const frame = raw.subarray(i + 8, i + 8 + len)
    ;(kind === 2 ? err : out).push(frame)
    i += 8 + len
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }
}

export class SandboxRuntime {
  private client?: Docker

  /** Connecting is lazy: a wrong URL is a SandboxError at first use, never a crash at boot (invariant 10). */
  constructor(readonly url: string) {}

  get docker(): Docker {
    this.client ??= connect(this.url)
    return this.client
  }

  async ping(): Promise<string> {
    const v = await api('ping', () => this.docker.version())
    return `Docker ${v.Version} (${v.Os}/${v.Arch})`
  }

  /** Pull an image unless it is present. Refs are pinned by digest in config, so "present" is exact. */
  async ensureImage(ref: string): Promise<void> {
    try {
      await api('image inspect', () => this.docker.getImage(ref).inspect())
      return
    } catch (err) {
      if (err instanceof SandboxError) throw err
      if (statusOf(err) !== 404) throw new SandboxError(`image ${ref}: ${(err as Error).message}`, 'image')
    }
    try {
      const stream = await api('pull', () => this.docker.pull(ref))
      await new Promise<void>((resolve, reject) => this.docker.modem.followProgress(stream, (e: Error | null) => (e ? reject(e) : resolve())))
    } catch (err) {
      if (err instanceof SandboxError) throw err
      throw new SandboxError(`cannot pull ${ref}: ${(err as Error).message}`, 'image')
    }
  }

  async volumeExists(name: string): Promise<boolean> {
    try {
      await api('volume inspect', () => this.docker.getVolume(name).inspect())
      return true
    } catch (err) {
      if (statusOf(err) === 404) return false
      throw err
    }
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    await api('volume create', () => this.docker.createVolume({ Name: name, Labels: labels }))
  }

  async removeVolume(name: string): Promise<void> {
    await api('volume remove', () => this.docker.getVolume(name).remove({ force: true })).catch((err) => {
      if (statusOf(err) !== 404) throw err
    })
  }

  async ensureNetwork(name: string, labels: Record<string, string>): Promise<void> {
    const found = await api('network list', () => this.docker.listNetworks({ filters: { name: [name] } }))
    if (found.some((n) => n.Name === name)) return
    await api('network create', () => this.docker.createNetwork({ Name: name, Driver: 'bridge', Labels: labels }))
  }

  /** Create and start a container from a spec built by sandbox/spec.ts. */
  async start(spec: Docker.ContainerCreateOptions): Promise<string> {
    const c = await api('create', () => this.docker.createContainer(spec)).catch((err) => {
      if (err instanceof SandboxError) throw err
      throw new SandboxError(`cannot create the sandbox: ${(err as Error).message}`, 'container')
    })
    try {
      await api('start', () => c.start())
    } catch (err) {
      await c.remove({ force: true }).catch(() => undefined)
      if (err instanceof SandboxError) throw err
      throw new SandboxError(`cannot start the sandbox: ${(err as Error).message}`, 'container')
    }
    return c.id
  }

  /** Create without starting: archive reads work on a stopped container (copying a binary out of an image). */
  async create(spec: Docker.ContainerCreateOptions): Promise<string> {
    const c = await api('create', () => this.docker.createContainer(spec))
    return c.id
  }

  /** Run a container to completion and return its exit code (a one-off helper). */
  async runToEnd(spec: Docker.ContainerCreateOptions, timeoutMs = HELPER_TIMEOUT_MS): Promise<number> {
    const id = await this.start(spec)
    const c = this.docker.getContainer(id)
    try {
      const r = (await Promise.race([
        api('wait', () => c.wait()),
        new Promise((_, reject) => setTimeout(() => reject(new SandboxError('helper container timed out', 'container')), timeoutMs)),
      ])) as { StatusCode: number }
      return r.StatusCode
    } finally {
      await c.remove({ force: true }).catch(() => undefined)
    }
  }

  /** Run a container to the end (a scanner) and return its exit code and output. Removed afterwards. */
  async runCapture(spec: Docker.ContainerCreateOptions, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const id = await this.start(spec)
    const c = this.docker.getContainer(id)
    try {
      let timedOut = false
      const waited = await Promise.race([
        api('wait', () => c.wait()) as Promise<{ StatusCode: number }>,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ])
      if (!waited) {
        timedOut = true
        await c.kill().catch(() => undefined)
      }
      const raw = (await api('logs', () => c.logs({ stdout: true, stderr: true, follow: false }))) as unknown as Buffer
      const { stdout, stderr } = demux(raw)
      return { code: waited?.StatusCode ?? -1, stdout, stderr, timedOut }
    } finally {
      await c.remove({ force: true }).catch(() => undefined)
    }
  }

  async remove(id: string): Promise<void> {
    await this.docker
      .getContainer(id)
      .remove({ force: true })
      .catch((err) => {
        if (statusOf(err) !== 404) throw err
      })
  }

  /**
   * Run argv in a running container. A timeout is enforced inside with coreutils `timeout` where
   * the image has it, and on our side in any case (the container is removed at the session's end).
   */
  async exec(id: string, argv: string[], opts: ExecOpts = {}): Promise<ExecResult> {
    const max = opts.maxBytes ?? EXEC_MAX_BYTES
    const timeoutS = opts.timeoutMs ? Math.ceil(opts.timeoutMs / 1000) : 0
    const cmd = timeoutS
      ? ['sh', '-c', `command -v timeout >/dev/null 2>&1 && exec timeout -k 5 ${timeoutS} "$@"; exec "$@"`, 'sh', ...argv]
      : argv
    const exec = await api('exec', () =>
      this.docker.getContainer(id).exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, AttachStdin: !!opts.input, WorkingDir: opts.cwd }),
    )
    const stream = await api('exec start', () => exec.start({ hijack: true, stdin: !!opts.input }))
    const out = new Capped(max)
    const err = new Capped(max)
    const both = new Capped(max)
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    stdout.on('data', (c: Buffer) => (out.push(c), both.push(c)))
    stderr.on('data', (c: Buffer) => (err.push(c), both.push(c)))
    this.docker.modem.demuxStream(stream, stdout, stderr)
    if (opts.input) {
      stream.write(opts.input)
      ;(stream as unknown as { end(): void }).end()
    }
    let timedOut = false
    await new Promise<void>((resolve, reject) => {
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true
            stream.destroy()
            resolve()
          }, opts.timeoutMs + GRACE_MS)
        : undefined
      stream.on('end', () => (clearTimeout(timer), resolve()))
      stream.on('close', () => (clearTimeout(timer), resolve()))
      stream.on('error', (e) => (clearTimeout(timer), reject(e)))
    })
    let code = -1
    if (!timedOut) {
      const info = await api('exec inspect', () => exec.inspect())
      code = info.ExitCode ?? -1
      if (timeoutS && TIMEOUT_CODES.has(code)) timedOut = true
    }
    return { code, stdout: out.toString(), stderr: err.toString(), output: both.toString(), timedOut }
  }

  async putArchive(id: string, path: string, tarball: Buffer): Promise<void> {
    await api('archive put', () => this.docker.getContainer(id).putArchive(tarball, { path }))
  }

  /** The regular file at `path`, or null when nothing (or not a file) is there. */
  async getFile(id: string, path: string, maxBytes: number): Promise<Buffer | null> {
    let stream: Readable
    try {
      stream = (await api('archive get', () => this.docker.getContainer(id).getArchive({ path }))) as unknown as Readable
    } catch (err) {
      if (statusOf(err) === 404) return null
      throw err
    }
    return (await firstFile(stream, maxBytes))?.content ?? null
  }

  /** Remove what a previous process left behind (a crash or a restart mid-session). */
  async reap(label: string): Promise<number> {
    const containers = await api('list', () => this.docker.listContainers({ all: true, filters: { label: [label] } }))
    for (const c of containers) await this.remove(c.Id)
    const { Volumes } = await api('volume list', () => this.docker.listVolumes({ filters: { label: [label] } }))
    for (const v of Volumes ?? []) await this.removeVolume(v.Name)
    return containers.length
  }
}
