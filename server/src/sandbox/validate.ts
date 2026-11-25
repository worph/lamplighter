import type { CheckDef } from '../checks/index.js'
import type { App } from '../context.js'
import { newId, now } from '../db/index.js'
import type { RepoRow } from '../repos/registry.js'
import { detect } from './detect.js'
import { openWorkspace, SandboxError, sandboxRuntime } from './index.js'
import { repoEnv, type RepoEnv } from './repo.js'
import { openSandbox } from './workspace.js'

/**
 * Mechanical validation (architecture §7.3 step 1): the repository's own commands on the base and
 * on the proposal, each side in a fresh sandbox, so the fixer's own green runs count for nothing
 * (invariant 2). Whatever passed on base must pass on the proposal (invariant 3). Red on base is
 * reported, not held against the fix; a head failure is run once more to rule out a flaky test.
 */

export interface CommandOutcome {
  ok: boolean
  exit: number
  ms: number
  timedOut: boolean
  /** The end of the output, for the PR body and the report. */
  tail: string
  cached?: boolean
}

export interface CommandResult {
  command: string
  base: CommandOutcome
  head: CommandOutcome
  /** Head failed where base passed, and was run once more. */
  reran?: boolean
  /** Base green, head red after the re-run: this command fails the proposal. */
  regression: boolean
}

export interface Mechanical {
  /** False when nothing could run: the sandbox is off, or the repository declares and shows no test. */
  ran: boolean
  ok: boolean
  reason?: string
  image?: string
  results: CommandResult[]
}

const TAIL_CHARS = 2000
const OUTPUT_BYTES = 40_000

/** The decision alone, given each side's outcomes (a re-run is asked for through `rerun`). */
export async function judge(
  commands: string[],
  base: CommandOutcome[],
  head: CommandOutcome[],
  rerun: (command: string) => Promise<CommandOutcome>,
): Promise<Pick<Mechanical, 'ok' | 'results'>> {
  const results: CommandResult[] = []
  for (let i = 0; i < commands.length; i++) {
    const command = commands[i]!
    let h = head[i]!
    const b = base[i]!
    let reran = false
    if (b.ok && !h.ok) {
      h = await rerun(command)
      reran = true
    }
    results.push({ command, base: b, head: h, ...(reran ? { reran } : {}), regression: b.ok && !h.ok })
  }
  return { ok: results.every((r) => !r.regression), results }
}

function cached(app: App, repo: string, sha: string, command: string, image: string): CommandOutcome | undefined {
  const row = app.db.prepare('SELECT ok, exit, ms, timed_out, tail FROM command_runs WHERE repo_key = ? AND sha = ? AND command = ? AND image = ?').get(repo, sha, command, image) as
    | { ok: number; exit: number; ms: number; timed_out: number; tail: string }
    | undefined
  return row ? { ok: !!row.ok, exit: row.exit, ms: row.ms, timedOut: !!row.timed_out, tail: row.tail, cached: true } : undefined
}

function remember(app: App, repo: string, sha: string, command: string, image: string, o: CommandOutcome) {
  app.db
    .prepare('INSERT OR REPLACE INTO command_runs (repo_key, sha, command, image, ok, exit, ms, timed_out, tail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(repo, sha, command, image, o.ok ? 1 : 0, o.exit, o.ms, o.timedOut ? 1 : 0, o.tail, now())
}

/** One fresh sandbox at `sha`: toolchains, then the install steps, then each command. */
async function runAt(app: App, repo: RepoRow, sha: string, env: RepoEnv, commands: string[]): Promise<CommandOutcome[]> {
  const rt = sandboxRuntime(app)!
  const cfg = app.config.current.sandbox
  const id = newId('v')
  const worktree = await app.mirrors.addWorktree(repo, id, sha)
  try {
    const ws = await openSandbox(rt, cfg, { sessionId: id, worktree, head: sha, env })
    try {
      const timeoutMs = cfg.command_timeout_s * 1000
      for (const step of ['mise install', ...env.install]) {
        const r = await ws.exec(step, { timeoutMs, maxBytes: OUTPUT_BYTES })
        if (r.code !== 0) {
          const tail = `install step \`${step}\` ${r.timedOut ? 'timed out' : `exited ${r.code}`}:\n${r.output.slice(-TAIL_CHARS)}`
          return commands.map(() => ({ ok: false, exit: r.code, ms: 0, timedOut: r.timedOut, tail }))
        }
      }
      const out: CommandOutcome[] = []
      for (const command of commands) {
        const started = Date.now()
        const r = await ws.exec(command, { timeoutMs, maxBytes: OUTPUT_BYTES })
        out.push({ ok: r.code === 0 && !r.timedOut, exit: r.code, ms: Date.now() - started, timedOut: r.timedOut, tail: r.output.slice(-TAIL_CHARS) })
      }
      return out
    } finally {
      await ws.dispose()
    }
  } finally {
    await app.mirrors.removeWorktree(repo, worktree)
  }
}

/** Run the repository's commands on base and head. Throws SandboxError on infra trouble (the caller blocks the round). */
export async function mechanical(app: App, repo: RepoRow, base: string, head: string): Promise<Mechanical> {
  if (!sandboxRuntime(app)) return { ran: false, ok: true, reason: 'the sandbox is off', results: [] }
  // The commands and the image come from the base: a fix may not change how it is judged.
  const id = newId('v')
  const worktree = await app.mirrors.addWorktree(repo, id, base)
  let env: RepoEnv
  try {
    env = repoEnv(worktree)
  } finally {
    await app.mirrors.removeWorktree(repo, worktree)
  }
  if (!env.test.length) return { ran: false, ok: true, reason: 'the repository declares no test command and none was detected', results: [] }
  const image = env.image ?? app.config.current.sandbox.base_image

  const baseOut: (CommandOutcome | undefined)[] = env.test.map((c) => cached(app, repo.key, base, c, image))
  const missing = env.test.filter((_, i) => !baseOut[i])
  if (missing.length) {
    const fresh = await runAt(app, repo, base, env, missing)
    missing.forEach((c, i) => {
      remember(app, repo.key, base, c, image, fresh[i]!)
      baseOut[env.test.indexOf(c)] = fresh[i]
    })
  }
  const headOut = await runAt(app, repo, head, env, env.test)
  const verdict = await judge(env.test, baseOut as CommandOutcome[], headOut, async (c) => (await runAt(app, repo, head, env, [c]))[0]!)
  return { ran: true, image, ...verdict }
}

/** The evidence, as markdown, for the report and the PR body. */
export function renderMechanical(m: Mechanical): string {
  if (!m.ran) return `_Tests not run: ${m.reason}._`
  const cell = (o: CommandOutcome) => `${o.ok ? 'pass' : o.timedOut ? 'timeout' : `fail (${o.exit})`} · ${(o.ms / 1000).toFixed(1)}s${o.cached ? ' · cached' : ''}`
  const rows = m.results.map((r) => `| \`${r.command}\` | ${cell(r.base)} | ${cell(r.head)}${r.reran ? ' · re-run' : ''} |`)
  const failed = m.results.filter((r) => r.regression).map((r) => `\n\n\`${r.command}\` on the proposal:\n\n\`\`\`\n${r.head.tail}\n\`\`\``)
  return [`| Command | Base | Proposal |`, `|---|---|---|`, ...rows].join('\n') + failed.join('')
}

/**
 * Detector cross-check (§7.3 step 2): the scanners on base and on the proposal. A finding the
 * proposal addresses that a scanner raised must be gone from the proposal — the deterministic
 * proof of a CVE fix — and no scanner may raise anything on the proposal that it did not on base.
 */
export interface ScanCheck {
  ran: boolean
  ok: boolean
  /** Addressed findings a scanner still reports on the proposal. */
  unfixed: string[]
  /** What a scanner reports on the proposal and not on base. */
  introduced: string[]
  notes: string[]
}

async function scanAt(app: App, repo: RepoRow, sha: string, checks: CheckDef[]) {
  const id = newId('d')
  const worktree = await app.mirrors.addWorktree(repo, id, sha)
  const rt = sandboxRuntime(app)
  try {
    const ws = checks.some((c) => c.detectors.some((d) => typeof d !== 'string')) ? await openWorkspace(app, { sessionId: id, worktree, head: sha }) : undefined
    try {
      const found = new Map<string, string>()
      const notes: string[] = []
      for (const c of checks) {
        const r = await detect(c, worktree, ws, rt ? { rt, cfg: app.config.current.sandbox } : undefined)
        for (const f of r.findings) found.set(`${c.kind}|${f.category}|${f.anchor}`, f.title)
        notes.push(...r.notes)
      }
      return { found, notes }
    } finally {
      await ws?.dispose?.()
    }
  } finally {
    await app.mirrors.removeWorktree(repo, worktree)
  }
}

export async function scanCheck(
  app: App,
  repo: RepoRow,
  checks: CheckDef[],
  base: string,
  head: string,
  addressed: { check: string; category: string; anchor: string }[],
): Promise<ScanCheck> {
  const withDetectors = checks.filter((c) => c.detectors.length)
  if (!withDetectors.length) return { ran: false, ok: true, unfixed: [], introduced: [], notes: ['no detector applies'] }
  let before: Awaited<ReturnType<typeof scanAt>>
  let after: Awaited<ReturnType<typeof scanAt>>
  try {
    before = await scanAt(app, repo, base, withDetectors)
    after = await scanAt(app, repo, head, withDetectors)
  } catch (err) {
    // The sandbox failing blocks the round (the caller); a registry or OSV hiccup in a built-in
    // detector only means this step could not run — it says nothing about the change (invariant 6).
    if (err instanceof SandboxError) throw err
    return { ran: false, ok: true, unfixed: [], introduced: [], notes: [`the scanners could not run: ${(err as Error).message}`] }
  }
  const unfixed = addressed
    .map((a) => `${a.check}|${a.category}|${a.anchor}`)
    .filter((k) => before.found.has(k) && after.found.has(k))
    .map((k) => after.found.get(k)!)
  const introduced = [...after.found.entries()].filter(([k]) => !before.found.has(k)).map(([, title]) => title)
  return { ran: true, ok: !unfixed.length && !introduced.length, unfixed, introduced, notes: [...new Set(after.notes)] }
}

export function renderScan(s: ScanCheck): string {
  if (!s.ran) return `_Scanners not run: ${s.notes.join('; ')}._`
  const lines = [s.ok ? 'The scanners report nothing new on the proposal, and every addressed finding they raised is gone.' : '']
  if (s.unfixed.length) lines.push(`Still reported on the proposal:\n${s.unfixed.map((t) => `- ${t}`).join('\n')}`)
  if (s.introduced.length) lines.push(`New on the proposal:\n${s.introduced.map((t) => `- ${t}`).join('\n')}`)
  lines.push(`_${s.notes.join(' · ')}_`)
  return lines.filter(Boolean).join('\n\n')
}
