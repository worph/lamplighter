import type { App } from '../context.js'
import { newId } from '../db/index.js'
import { logEvent } from '../events.js'
import { decide, DecisionError, type FindingRow } from '../findings/index.js'
import { getGroup, getRepo, settingsFor } from '../repos/registry.js'
import { openCount } from '../activity/index.js'
import { arbiterPrompt } from '../sessions/prompt.js'
import type { Session } from '../sessions/session.js'
import { LocalWorkspace } from '../sessions/workspace.js'
import { drive, endRound, infraAlert, insertRound, isInfra, maybePropose, type QueueRow } from '../sessions/engine.js'
import { ALL_CHECKS, precedents } from './index.js'

/** One arbiter session judges at most this many findings; the rest wait for the next. */
const MAX_CANDIDATES = 40

/**
 * The arbiter (§6.4): one session per repo, over the findings rounds left open, with the policy,
 * the backlog and the precedents in view. It reads the line and decides; the backend applies its
 * decisions. A failure decides nothing: the findings stay open, the lamp stays dim (invariant 6).
 */
export async function runArbitration(app: App, job: QueueRow): Promise<string | undefined> {
  const repo = getRepo(app.db, job.repo_key)
  const candidates = app.db
    .prepare("SELECT * FROM findings WHERE repo_key = ? AND state = 'open' ORDER BY created_at LIMIT ?")
    .all(repo.key, MAX_CANDIDATES) as FindingRow[]
  if (!candidates.length) return undefined
  const head = await app.mirrors.fetch(repo)
  const id = newId('r')
  insertRound(app, { id, repo: repo.key, def: { kind: ALL_CHECKS, revision: 0 }, kind: 'arbitrate', scope: 'full', head, trigger: job.trigger })
  const shown = precedents(app, repo, candidates)
  let worktree: string | undefined
  let session: Session | undefined
  try {
    worktree = await app.mirrors.addWorktree(repo, id, head)
    session = app.sessions.open({
      id, kind: 'arbiter', repo, worktree, ws: new LocalWorkspace(worktree), head, allowWrite: false,
      arbiter: {
        candidates: new Map(candidates.map((f) => [f.id, { sensitive: !!f.sensitive }])),
        precedents: new Set(shown.map((p) => p.id)),
        decisions: [],
      },
      timeoutS: app.config.current.inference.timeout_s, runTimeoutS: app.config.current.sandbox.run_timeout_s,
    })
    const backlog: Record<string, number> = {}
    for (const r of app.db.prepare("SELECT check_kind, COUNT(*) AS n FROM findings WHERE repo_key = ? AND state IN ('admitted','proposed') GROUP BY check_kind").all(repo.key) as { check_kind: string; n: number }[]) {
      backlog[r.check_kind] = r.n
    }
    const inFlight = (app.db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE repo_key = ? AND state IN ('drafting','validating','ready','held','submitted')").get(repo.key) as { n: number }).n
    const prompt = arbiterPrompt({
      repo, worktree, groupPolicy: getGroup(app.db, repo.group_id).policy,
      candidates: candidates.map((finding) => {
        const def = app.checks.get(finding.check_kind)
        return { finding, lean: def ? settingsFor(app, repo, def).lean : 'admit' }
      }),
      precedents: shown, backlog, inFlight,
      openItems: openCount(app.db, repo.key), openItemsCap: app.config.current.schedule.open_items_per_repo,
    })
    const result = await drive(app, session, prompt, id)
    const made = session.arbiter!.decisions
    const applied: string[] = []
    const admitted = new Set<string>()
    for (const d of made) {
      const f = candidates.find((c) => c.id === d.finding_id)!
      try {
        decide(app.db, {
          id: d.finding_id, decision: d.decision, by: 'arbiter', actor: 'arbiter', rationale: d.rationale, precedents: d.precedents,
          session: id, checkRevision: app.checks.get(f.check_kind)?.revision,
        })
      } catch (err) {
        // A person or a newer round moved it meanwhile: theirs stands.
        if (err instanceof DecisionError) continue
        throw err
      }
      applied.push(`- **${d.decision}** [${f.id}] ${f.title} (${f.check_kind}) — ${d.rationale}`)
      if (d.decision === 'admit') admitted.add(f.check_kind)
    }
    const undecided = candidates.filter((c) => !made.some((d) => d.finding_id === c.id))
    const count = (k: string) => made.filter((d) => d.decision === k).length
    const summary = `${count('admit')} admitted · ${count('defer')} not now · ${count('decline')} declined${undecided.length ? ` · ${undecided.length} undecided` : ''}`
    const narrative = session.done?.status === 'cannot' ? `**The arbiter could not decide:** ${session.done.text}` : (session.done?.text ?? result.text)
    const report = [
      `# Admission — ${repo.key}`,
      '',
      narrative,
      '',
      '## Decisions',
      '',
      applied.join('\n') || '_None._',
      ...(undecided.length ? ['', '## Left open (judged next time)', '', ...undecided.map((f) => `- [${f.id}] ${f.title} (${f.check_kind})`)] : []),
      '',
      `_${summary}_`,
    ].join('\n')
    endRound(app, id, { status: 'done', summary, report, usage: result.usage })
    logEvent(app.db, { code: 'ARBITRATED', repo: repo.key, message: `admission: ${summary}`, detail: { round: id } })
    for (const kind of admitted) {
      const def = app.checks.get(kind)
      if (def) maybePropose(app, repo, def)
    }
    return id
  } catch (err) {
    const infra = isInfra(err)
    endRound(app, id, { status: infra ? 'blocked' : 'failed', error: (err as Error).message })
    logEvent(app.db, { level: infra ? 'warn' : 'error', code: infra ? 'ARBITRATION_BLOCKED' : 'ARBITRATION_FAILED', repo: repo.key, message: `admission: ${(err as Error).message}`, detail: { round: id } })
    infraAlert(app, err)
    throw err
  } finally {
    if (session) app.sessions.close(session)
    if (worktree) await app.mirrors.removeWorktree(repo, worktree)
  }
}
