import type { SandboxConfig } from '../config/index.js'
import { packTar, SandboxError, type SandboxRuntime } from './runtime.js'
import { CACHE_VOLUME, chownSpec, LABEL, MISE_VOLUME, sourceSpec, volumesSpec } from './spec.js'

/**
 * What every sandbox shares, created once: the sandboxes' network, the toolchain volume with
 * mise in it, and the package-manager cache volume. Toolchains are installed on demand by mise
 * at the version the repository's own files name (architecture §10.1), so no image of ours exists.
 */

const SHARED = { 'lamplighter.shared': 'true' }
const MISE_BINARY = '/usr/local/bin/mise'
const MISE_MAX_BYTES = 400 * 1024 * 1024
/** Used only when a repository names no version: its own files win (lower precedence than any repo config). */
const MISE_DEFAULTS = '[tools]\nnode = "lts"\npython = "3.12"\n'

async function ensureVolume(rt: SandboxRuntime, cfg: SandboxConfig, name: string): Promise<void> {
  if (await rt.volumeExists(name)) return
  await rt.createVolume(name, SHARED)
  const code = await rt.runToEnd(chownSpec(cfg, { volume: name, image: cfg.base_image }))
  if (code !== 0) throw new SandboxError(`cannot hand volume ${name} to uid ${cfg.uid} (exit ${code})`, 'container')
}

/** Copy mise's static binary from its official image into the toolchain volume, when the pinned image changed. */
async function seedMise(rt: SandboxRuntime, cfg: SandboxConfig): Promise<void> {
  const helper = await rt.start(volumesSpec(cfg, { image: cfg.base_image }))
  try {
    const marker = await rt.exec(helper, ['cat', '/mise/bin/.image'])
    if (marker.code === 0 && marker.stdout.trim() === cfg.mise_image) return
    await rt.ensureImage(cfg.mise_image)
    const source = await rt.create(sourceSpec(cfg, { image: cfg.mise_image }))
    let binary: Buffer | null
    try {
      binary = await rt.getFile(source, MISE_BINARY, MISE_MAX_BYTES)
    } finally {
      await rt.remove(source)
    }
    if (!binary) throw new SandboxError(`${cfg.mise_image} has no ${MISE_BINARY}`, 'image')
    const tarball = await packTar(
      [
        { name: 'bin', type: 'directory' },
        { name: 'bin/mise', content: binary, mode: 0o755 },
        { name: 'bin/.image', content: Buffer.from(`${cfg.mise_image}\n`) },
        { name: 'config.toml', content: Buffer.from(MISE_DEFAULTS) },
      ],
      cfg.uid,
    )
    await rt.putArchive(helper, '/mise', tarball)
  } finally {
    await rt.remove(helper)
  }
}

let ready: { key: string; done: Promise<void> } | undefined

/** Idempotent and memoised per configuration; a failure is not cached, so the next session retries. */
export function ensureInfra(rt: SandboxRuntime, cfg: SandboxConfig): Promise<void> {
  const key = JSON.stringify([rt.url, cfg.network, cfg.base_image, cfg.mise_image, cfg.uid])
  if (ready?.key === key) return ready.done
  const done = (async () => {
    await rt.ensureNetwork(cfg.network, SHARED)
    await rt.ensureImage(cfg.base_image)
    await ensureVolume(rt, cfg, MISE_VOLUME)
    await ensureVolume(rt, cfg, CACHE_VOLUME)
    await seedMise(rt, cfg)
  })()
  ready = { key, done }
  done.catch(() => {
    if (ready?.done === done) ready = undefined
  })
  return done
}

/** At boot: containers and work volumes a previous process left behind. */
export function reapOrphans(rt: SandboxRuntime): Promise<number> {
  return rt.reap(LABEL)
}

/**
 * Past `cache_max_gb`, empty the package cache (the toolchains stay). Coarse on purpose: an LRU is
 * later hardening (architecture §13), and an emptied cache only costs the next install its time.
 */
export async function trimCaches(rt: SandboxRuntime, cfg: SandboxConfig): Promise<{ gb: number; emptied: boolean }> {
  const helper = await rt.start(volumesSpec(cfg, { image: cfg.base_image }))
  try {
    const du = await rt.exec(helper, ['du', '-sk', '/cache', '/mise'])
    const kb = du.stdout
      .split('\n')
      .map((l) => Number(l.split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => a + b, 0)
    const gb = kb / 1024 / 1024
    if (gb <= cfg.cache_max_gb) return { gb, emptied: false }
    await rt.exec(helper, ['sh', '-c', 'find /cache -mindepth 1 -maxdepth 1 -exec rm -rf {} +'])
    return { gb, emptied: true }
  } finally {
    await rt.remove(helper)
  }
}
