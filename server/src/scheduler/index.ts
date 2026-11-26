import type { App } from '../context.js'
import { newId, now } from '../db/index.js'
import { logEvent } from '../events.js'
import { listRepos, getRepo, settingsFor, type RepoRow } from '../repos/registry.js'
import { runAuthor, runRound, type QueueRow } from '../sessions/engine.js'
import { pollPullRequests, retryAutoSubmits } from '../delivery/index.js'
import { checkAllForges } from '../repos/access.js'
import { openAlert } from '../activity/index.js'
import { runArbitration } from '../admission/arbiter.js'

/**
 * One queue, served in order (Touchstone's model): foreground (what a person asked for, first in
 * first out), then background by tier — 1 security/cve on new commits, 2 other diff rounds,
 * 3 fixing what rounds found, 4 full rounds whose check revision moved, 5 full rounds past their
 * cadence; at 2 as well, a repo's arbitration, once its rounds have settled. The budget gates agent
 * sessions; detector-only rounds are free.
 */

const DAY_MS = 86_400_000
/** Tokens expire and get revoked: how often the forges' credentials are re-checked. */
const AUTH_CHECK_MS = 30 * 60_000
/** How often open pull requests are followed. */
const PR_POLL_MS = 5 * 60_000
/** The most repos fetched in one tick, so a large fleet does not stall the tick. */
const MAX_POLLS_PER_TICK = 20

export function enqueueRound(
  app: App,
  j: { repo: string; check: string; scope: 'diff' | 'full'; base?: string | null; head?: string | null; foreground?: boolean; tier?: number; trigger: string },
): { id: string; coalesced: boolean } {
  // A queued (not started) job for the same repo, check and scope absorbs the new one: a burst of
  // pushes becomes one diff round over the whole range.
  const existing = app.db
    .prepare("SELECT * FROM queue WHERE job = 'round' AND repo_key = ? AND check_kind = ? AND scope = ? AND state = 'queued'")
    .get(j.repo, j.check, j.scope) as QueueRow | undefined
  if (existing) {
    app.db
      .prepare('UPDATE queue SET head_sha = COALESCE(?, head_sha), foreground = MAX(foreground, ?), tier = MIN(tier, ?), created_at = CASE WHEN ? THEN created_at ELSE ? END WHERE id = ?')
      .run(j.head ?? null, j.foreground ? 1 : 0, j.tier ?? 5, j.foreground ? 1 : 0, now(), existing.id)
    return { id: existing.id, coalesced: true }
  }
  const id = newId('q')
  app.db
    .prepare(
      'INSERT INTO queue (id, job, repo_key, check_kind, scope, base_sha, head_sha, foreground, tier, trigger, created_at) VALUES (?, \'round\', ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, j.repo, j.check, j.scope, j.base ?? null, j.head ?? null, j.foreground ? 1 : 0, j.tier ?? 5, j.trigger, now())
  app.kick()
  return { id, coalesced: false }
}

export function sessionsThisHour(app: App): number {
  const since = new Date(Date.now() - 3600_000).toISOString()
  return (app.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE agent = 1 AND at > ?').get(since) as { n: number }).n
}

export interface ScheduleView {
  running: QueueRow[]
  queued: (QueueRow & { waiting?: string })[]
  budget: { sessions_this_hour: number; sessions_per_hour: number; slots: number }
  enabled: boolean
  rotation: boolean
}

export class Scheduler {
  private timer: NodeJS.Timeout | undefined
  private ticking = false
  private running = new Map<string, Promise<void>>()
  private lastPrPoll = 0
  private lastAuthCheck = 0
  /** The credential re-check in flight, if any: it runs beside the tick, never inside it. */
  private authCheck: Promise<void> | undefined

  constructor(private readonly app: App) {
    // A job that was running when the process died never finished: put it back in line.
    app.db.prepare("UPDATE queue SET state = 'queued', started_at = NULL WHERE state = 'running'").run()
    app.db.prepare("UPDATE rounds SET status = 'failed', error = 'interrupted by a restart', ended_at = ? WHERE status = 'running'").run(now())
    app.db.prepare("UPDATE proposals SET state = 'failed', error = 'interrupted by a restart' WHERE state IN ('drafting','validating')").run()
  }

  start(): void {
    const loop = () => {
      void this.tick().finally(() => {
        this.timer = setTimeout(loop, this.app.config.current.schedule.tick_s * 1000)
      })
    }
    this.timer = setTimeout(loop, 2000)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
  }

  /** Called by `app.kick()`: dispatch without waiting for the next tick. */
  nudge(): void {
    setImmediate(() => this.dispatch())
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const cfg = this.app.config.current.schedule
      if (!cfg.enabled) return
      await this.poll()
      if (cfg.rotation) this.rotate()
      // Tokens expire and get revoked: re-check every half hour (and on the first tick), so the
      // alert opens before a delivery finds out. It asks the forge about every repo, so it is not
      // awaited here: dispatch does not wait for it, and a check still in flight is not restarted.
      if (!this.authCheck && Date.now() - this.lastAuthCheck > AUTH_CHECK_MS) {
        this.lastAuthCheck = Date.now()
        // Best effort: a failed check is retried on the next due tick.
        this.authCheck = checkAllForges(this.app)
          .catch(() => undefined)
          .finally(() => {
            this.authCheck = undefined
          })
      }
      if (Date.now() - this.lastPrPoll > PR_POLL_MS) {
        this.lastPrPoll = Date.now()
        // Best effort: pollPullRequests logs per-PR failures itself; the next due tick tries again.
        await pollPullRequests(this.app).catch(() => undefined)
      }
      // Best effort: retryAutoSubmits logs each failed delivery itself; the next tick tries again.
      await retryAutoSubmits(this.app).catch(() => undefined)
      this.dispatch()
    } finally {
      this.ticking = false
    }
  }

  /** Fetch every remote that is due; new foreign commits become diff rounds. */
  private async poll(): Promise<void> {
    const cfg = this.app.config.current.schedule
    const due = listRepos(this.app.db).filter((r) => !r.last_fetch_at || Date.now() - Date.parse(r.last_fetch_at) > cfg.poll_min * 60_000)
    // Best effort per repo: pollOne logs a failed fetch itself; one repo must not stop the others.
    for (const repo of due.slice(0, MAX_POLLS_PER_TICK)) await this.pollOne(repo).catch(() => undefined)
  }

  async pollOne(repo: RepoRow): Promise<void> {
    let head: string
    try {
      head = await this.app.mirrors.fetch(repo)
    } catch (err) {
      logEvent(this.app.db, { level: 'warn', code: 'FETCH_FAILED', repo: repo.key, message: (err as Error).message })
      return
    }
    if (!repo.last_head) {
      this.app.db.prepare('UPDATE repos SET last_head = ? WHERE key = ?').run(head, repo.key)
      logEvent(this.app.db, { code: 'REPO_ENROLLED', repo: repo.key, message: `tracking ${repo.line} at ${head.slice(0, 10)}` })
      return
    }
    if (head === repo.last_head) return
    const advanced = await this.app.mirrors.isAncestor(repo, repo.last_head, head)
    const foreign = advanced ? await this.app.mirrors.foreignCommits(repo, repo.last_head, head) : ['history-rewritten']
    this.app.db.prepare('UPDATE repos SET last_head = ? WHERE key = ?').run(head, repo.key)
    if (!foreign.length) {
      logEvent(this.app.db, { code: 'OWN_COMMITS', repo: repo.key, message: `${repo.line} moved to ${head.slice(0, 10)} by Lamplighter's own commits — no round (loop guard)` })
      return
    }
    logEvent(this.app.db, { code: 'NEW_COMMITS', repo: repo.key, message: `${foreign.length} new commit(s) on ${repo.line}, now ${head.slice(0, 10)}` })
    for (const def of this.app.checks.list()) {
      if (!def.scopes.includes('diff')) continue
      if (!settingsFor(this.app, repo, def).enabled) continue
      enqueueRound(this.app, {
        repo: repo.key, check: def.kind, scope: advanced ? 'diff' : 'full', base: advanced ? repo.last_head : null, head,
        tier: def.kind === 'security' || def.kind === 'cve' ? 1 : 2, trigger: 'push',
      })
    }
  }

  /** Full rounds that are due by cadence (or because the check's revision moved), stalest first. */
  private rotate(): void {
    const added: string[] = []
    for (const repo of listRepos(this.app.db)) {
      if (!repo.last_head) continue
      for (const def of this.app.checks.list()) {
        const s = settingsFor(this.app, repo, def)
        if (!s.enabled || !def.scopes.includes('full')) continue
        const last = this.app.db
          .prepare("SELECT started_at, check_revision FROM rounds WHERE repo_key = ? AND check_kind = ? AND kind = 'round' AND scope = 'full' AND status = 'done' ORDER BY started_at DESC LIMIT 1")
          .get(repo.key, def.kind) as { started_at: string; check_revision: number } | undefined
        const stale = !last || Date.now() - Date.parse(last.started_at) > s.cadence_days * DAY_MS
        const moved = !!last && last.check_revision < def.revision
        if (!stale && !moved) continue
        const queued = this.app.db.prepare("SELECT 1 FROM queue WHERE repo_key = ? AND check_kind = ? AND state IN ('queued','running')").get(repo.key, def.kind)
        if (queued) continue
        enqueueRound(this.app, { repo: repo.key, check: def.kind, scope: 'full', tier: moved ? 4 : 5, trigger: moved ? 'revision' : 'cadence' })
        added.push(`${repo.key}/${def.kind}`)
        if (added.length >= 50) return
      }
    }
  }

  private nextJobs(): QueueRow[] {
    return this.app.db
      .prepare("SELECT * FROM queue WHERE state = 'queued' ORDER BY foreground DESC, tier ASC, created_at ASC LIMIT 200")
      .all() as QueueRow[]
  }

  private waitingReason(j: QueueRow): string | undefined {
    const cfg = this.app.config.current.schedule
    if ((j.trigger === 'push' || j.job === 'arbitrate') && Date.now() - Date.parse(j.created_at) < cfg.debounce_min * 60_000) return 'debounce'
    if (j.job === 'arbitrate' && this.app.db.prepare("SELECT 1 FROM queue WHERE job = 'round' AND repo_key = ? AND state IN ('queued','running')").get(j.repo_key)) {
      return "the repo's rounds are still settling"
    }
    const def = this.app.checks.get(j.check_kind)
    const agent = j.job === 'author' || def?.agent !== 'none'
    if (agent && !j.foreground && sessionsThisHour(this.app) >= cfg.sessions_per_hour) return 'hourly session budget spent'
    for (const r of this.running.keys()) {
      const row = this.app.db.prepare('SELECT repo_key, check_kind FROM queue WHERE id = ?').get(r) as { repo_key: string; check_kind: string } | undefined
      if (row && row.repo_key === j.repo_key && row.check_kind === j.check_kind) return 'same repo and check already running'
    }
    return undefined
  }

  dispatch(): void {
    if (!this.app.config.current.schedule.enabled) return
    const slots = this.app.config.current.schedule.slots
    for (const j of this.nextJobs()) {
      if (this.running.size >= slots) return
      if (this.waitingReason(j)) continue
      this.app.db.prepare("UPDATE queue SET state = 'running', started_at = ? WHERE id = ?").run(now(), j.id)
      const p = this.run(j).finally(() => {
        this.running.delete(j.id)
        this.nudge()
      })
      this.running.set(j.id, p)
    }
  }

  private async run(j: QueueRow): Promise<void> {
    try {
      getRepo(this.app.db, j.repo_key)
      if (j.job === 'author') await runAuthor(this.app, j)
      else if (j.job === 'arbitrate') await runArbitration(this.app, j)
      else await runRound(this.app, j)
      this.app.db.prepare("UPDATE queue SET state = 'done' WHERE id = ?").run(j.id)
    } catch (err) {
      this.app.db.prepare("UPDATE queue SET state = 'failed' WHERE id = ?").run(j.id)
      if (!(err instanceof Error && err.name === 'InferenceError')) {
        openAlert(this.app.db, `job.${j.check_kind}`, `A ${j.job} job failed`, `${j.repo_key} / ${j.check_kind}: ${(err as Error).message}`)
      }
    } finally {
      // Done rows are history the queue view does not need beyond a day.
      this.app.db.prepare("DELETE FROM queue WHERE state IN ('done','failed') AND created_at < ?").run(new Date(Date.now() - DAY_MS).toISOString())
    }
  }

  view(): ScheduleView {
    const cfg = this.app.config.current.schedule
    const all = this.app.db.prepare("SELECT * FROM queue WHERE state IN ('queued','running') ORDER BY foreground DESC, tier ASC, created_at ASC").all() as QueueRow[]
    return {
      running: all.filter((j) => j.state === 'running'),
      queued: all.filter((j) => j.state === 'queued').map((j) => ({ ...j, waiting: this.waitingReason(j) })),
      budget: { sessions_this_hour: sessionsThisHour(this.app), sessions_per_hour: cfg.sessions_per_hour, slots: cfg.slots },
      enabled: cfg.enabled,
      rotation: cfg.rotation,
    }
  }
}
