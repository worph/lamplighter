import type { App } from '../context.js'
import { LocalWorkspace, type Workspace } from '../sessions/workspace.js'
import { ensureInfra, reapOrphans, trimCaches } from './infra.js'
import { SandboxRuntime } from './runtime.js'
import { openSandbox, type SandboxWorkspace } from './workspace.js'

export { SandboxError } from './runtime.js'

/**
 * The session sandbox (architecture §10.1) as the engine sees it. Disabled: every session works on
 * the local worktree and nothing of the repository runs (v1, invariant 10). Enabled: every session
 * gets a container, and Docker trouble blocks the round with an alert (invariant 6) rather than
 * falling back silently.
 */

let cached: SandboxRuntime | undefined

export function sandboxRuntime(app: App): SandboxRuntime | undefined {
  const cfg = app.config.current.sandbox
  if (!cfg.enabled) return undefined
  if (cached?.url !== cfg.docker_url) cached = new SandboxRuntime(cfg.docker_url)
  return cached
}

export type SessionWorkspace = Workspace & { dispose?(): Promise<void> }

export async function openWorkspace(app: App, o: { sessionId: string; worktree: string; head: string }): Promise<SessionWorkspace> {
  const rt = sandboxRuntime(app)
  if (!rt) return new LocalWorkspace(o.worktree)
  return openSandbox(rt, app.config.current.sandbox, o)
}

export function isSandbox(ws: Workspace): ws is SandboxWorkspace {
  return typeof (ws as SandboxWorkspace).exportPatch === 'function'
}

/** Settings → Sandbox → Test: reach Docker, then make sure the shared network, images and volumes exist (works while disabled). */
export async function probeSandbox(app: App): Promise<{ ok: boolean; detail: string }> {
  const cfg = app.config.current.sandbox
  const rt = new SandboxRuntime(cfg.docker_url)
  try {
    const version = await rt.ping()
    await ensureInfra(rt, cfg)
    return { ok: true, detail: `${version}; network ${cfg.network}, base image, mise and the cache volumes are ready` }
  } catch (err) {
    return { ok: false, detail: (err as Error).message }
  }
}

/** Boot: remove sandboxes a previous process left. Daily: keep the caches under their cap. Never fatal (invariant 10). */
export async function sandboxHousekeeping(app: App, what: 'reap' | 'trim'): Promise<string | undefined> {
  const rt = sandboxRuntime(app)
  if (!rt) return undefined
  try {
    if (what === 'reap') {
      const n = await reapOrphans(rt)
      return n ? `removed ${n} sandbox(es) left by a previous run` : undefined
    }
    const r = await trimCaches(rt, app.config.current.sandbox)
    return r.emptied ? `sandbox caches were ${r.gb.toFixed(1)} GB, over the cap: package cache emptied` : undefined
  } catch (err) {
    return `sandbox ${what} failed: ${(err as Error).message}`
  }
}
