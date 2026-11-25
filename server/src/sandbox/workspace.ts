import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { SandboxConfig } from '../config/index.js'
import { git } from '../forges/gitcli.js'
import { lexicalRel, ToolInputError, type Workspace } from '../sessions/workspace.js'
import { ensureInfra } from './infra.js'
import { repoEnv, type RepoEnv } from './repo.js'
import { packTar, SandboxError, type ExecResult, type SandboxRuntime } from './runtime.js'
import { LABEL, REPO_DIR, sessionSpec, workVolume } from './spec.js'

/**
 * A session's sandbox: one container for the session's whole life, holding a clone of the
 * repository at the session's commit — with history, without a remote, without a credential.
 * Lamplighter drives it from outside: files through the archive API, everything else by exec,
 * never through a login shell (architecture §10.1).
 */

const READ_MAX = 5_000_000
const GIT_MAX = 64 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
const PATCH_MAX = 5_000_000
/** Never part of a change, even in a repository that does not ignore them. */
const NEVER_COMMITTED = [':(exclude,glob)**/node_modules/**', ':(exclude,glob)**/.venv/**', ':(exclude,glob)**/__pycache__/**']

export class SandboxWorkspace implements Workspace {
  constructor(
    private readonly rt: SandboxRuntime,
    private readonly cfg: SandboxConfig,
    readonly sessionId: string,
    readonly container: string,
    readonly env: RepoEnv,
    readonly image: string,
  ) {}

  private abs(rel: string): string {
    return posix.join(REPO_DIR, rel)
  }

  /** The lexical check, then the real path inside the container: a symlink may not lead out of the repo or into .git. */
  async resolve(p: unknown): Promise<string> {
    const rel = lexicalRel(p)
    const r = await this.rt.exec(this.container, ['realpath', '-m', '--', this.abs(rel)], { timeoutMs: GIT_TIMEOUT_MS })
    const real = r.stdout.trim()
    if (r.code !== 0 || !real.startsWith(`${REPO_DIR}/`)) throw new ToolInputError(`path escapes the repository: ${String(p)}`)
    if (real.slice(REPO_DIR.length + 1).split('/')[0] === '.git') throw new ToolInputError('the .git directory is not part of the workspace')
    return rel
  }

  async git(args: string[]): Promise<string> {
    const r = await this.rt.exec(this.container, ['git', '-c', 'core.quotepath=off', ...args], { cwd: REPO_DIR, timeoutMs: GIT_TIMEOUT_MS, maxBytes: GIT_MAX })
    if (r.code !== 0) throw Object.assign(new Error(`git ${args[0]} exited ${r.code}: ${r.stderr.trim().slice(0, 500)}`), { code: r.code })
    return r.stdout
  }

  async readFile(rel: string): Promise<Buffer | null> {
    return this.rt.getFile(this.container, this.abs(rel), READ_MAX)
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const parts = rel.split('/')
    const dirs = parts.slice(0, -1).map((_, i) => ({ name: parts.slice(0, i + 1).join('/'), type: 'directory' as const }))
    await this.rt.putArchive(this.container, REPO_DIR, await packTar([...dirs, { name: rel, content: Buffer.from(content) }], this.cfg.uid))
  }

  async deleteFile(rel: string): Promise<boolean> {
    const r = await this.rt.exec(this.container, ['sh', '-c', 'test -f "$1" || test -L "$1" || exit 3; rm -f -- "$1"', 'sh', this.abs(rel)])
    return r.code === 0
  }

  exec(command: string, opts: { timeoutMs: number; maxBytes: number }): Promise<ExecResult> {
    return this.rt.exec(this.container, ['sh', '-c', command], { cwd: REPO_DIR, ...opts })
  }

  /** The session's change as a binary patch against its commit; empty when nothing changed. */
  async exportPatch(): Promise<string> {
    await this.git(['add', '-A', '--', '.', ...NEVER_COMMITTED])
    const patch = await this.git(['diff', '--cached', '--binary', 'HEAD'])
    if (patch.length > PATCH_MAX) throw new Error(`the change is ${patch.length} bytes, over the ${PATCH_MAX} limit`)
    return patch
  }

  /** Put static binaries (fix tools) on the sandbox's PATH. */
  async addTools(files: { name: string; content: Buffer }[]): Promise<void> {
    if (!files.length) return
    await this.rt.putArchive(this.container, '/opt', await packTar([{ name: 'tools', type: 'directory' }, ...files.map((f) => ({ name: `tools/${f.name}`, content: f.content, mode: 0o755 }))], this.cfg.uid))
  }

  async dispose(): Promise<void> {
    await this.rt.remove(this.container).catch(() => undefined)
    await this.rt.removeVolume(workVolume(this.sessionId)).catch(() => undefined)
  }
}

/** The worktree's history up to its HEAD, as one bundle file: everything a clone needs, nothing of the mirror's config. */
async function bundle(worktree: string): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'll-bundle-'))
  try {
    const file = join(dir, 'repo.bundle')
    await git(['bundle', 'create', '-q', file, 'HEAD'], { cwd: worktree, timeoutMs: 600_000 })
    return readFileSync(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Open a sandbox for one session on `worktree` (the host worktree at `head`). `env` overrides what
 * the worktree declares (validation judges a proposal by its base's commands). The container is
 * removed by `dispose`; one left behind by a crash is reaped at the next boot (label).
 */
export async function openSandbox(rt: SandboxRuntime, cfg: SandboxConfig, o: { sessionId: string; worktree: string; head: string; env?: RepoEnv }): Promise<SandboxWorkspace> {
  await ensureInfra(rt, cfg)
  const env = o.env ?? repoEnv(o.worktree)
  const image = env.image ?? cfg.base_image
  await rt.ensureImage(image)
  const vol = workVolume(o.sessionId)
  await rt.createVolume(vol, { [LABEL]: o.sessionId })
  let container: string
  try {
    container = await rt.start(sessionSpec(cfg, { sessionId: o.sessionId, image }))
  } catch (err) {
    await rt.removeVolume(vol).catch(() => undefined)
    throw err
  }
  const ws = new SandboxWorkspace(rt, cfg, o.sessionId, container, env, image)
  try {
    // /work is the volume's root (root-owned); the clone lives in a directory the sandbox user owns.
    await rt.putArchive(container, '/work', await packTar([{ name: 'repo', type: 'directory' }], cfg.uid))
    await rt.putArchive(container, '/tmp', await packTar([{ name: 'repo.bundle', content: await bundle(o.worktree) }], cfg.uid))
    const clone = await rt.exec(
      container,
      ['sh', '-c', 'git clone -q /tmp/repo.bundle "$1" && cd "$1" && git remote remove origin && git checkout -q --detach "$2" && rm -f /tmp/repo.bundle', 'sh', REPO_DIR, o.head],
      { cwd: '/work', timeoutMs: 600_000 },
    )
    if (clone.code !== 0) throw new SandboxError(`cannot clone into the sandbox: ${clone.output.trim().slice(0, 500)}`, 'container')
    for (const cmd of env.setup) {
      const r = await ws.exec(cmd, { timeoutMs: cfg.command_timeout_s * 1000, maxBytes: 20_000 })
      if (r.code !== 0) throw new Error(`sandbox setup "${cmd}" failed (exit ${r.code}): ${r.output.slice(-2000)}`)
    }
    return ws
  } catch (err) {
    await ws.dispose()
    throw err
  }
}

