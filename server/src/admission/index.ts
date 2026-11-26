import type { App } from '../context.js'
import { newId, now } from '../db/index.js'
import { logEvent } from '../events.js'
import { decide, decidedBy, getFinding, type DecisionKind, type FindingRow } from '../findings/index.js'
import { getRepo, settingsFor, type RepoRow } from '../repos/registry.js'
import { maybePropose } from '../sessions/engine.js'

/**
 * Admission (§6.4): what a source raised becomes work only once judged. Three tiers, cheapest
 * first: the check's rule, then the arbiter (one session per repo, across checks), and at any time a
 * person. Rounds raise; this decides (invariant 11).
 */

/** The queue's check column for a job that is about every check of a repo. */
export const ALL_CHECKS = '*'

/**
 * The rule tier, on findings a round just left open: `always` (or a matching `always_when`) admits,
 * `manual` defers, `arbiter` waits for the arbiter. Returns how many still wait for it.
 */
export function applyRules(app: App, repo: RepoRow, ids: string[]): number {
  let pending = 0
  for (const id of ids) {
    const f = getFinding(app.db, id)
    if (!f || f.state !== 'open') continue
    const def = app.checks.get(f.check_kind)
    if (!def) {
      pending++
      continue
    }
    const s = settingsFor(app, repo, def)
    const rule = { by: 'rule' as const, actor: 'lamplighter', checkRevision: def.revision }
    if (def.always_when?.severity.includes(f.severity as 'critical' | 'major' | 'minor')) {
      decide(app.db, { ...rule, id, decision: 'admit', rationale: `Admitted by rule: ${def.kind} admits every ${f.severity} finding.` })
    } else if (s.admission === 'always') {
      decide(app.db, { ...rule, id, decision: 'admit', rationale: `Admitted by rule: ${def.kind} findings always become work.` })
    } else if (s.admission === 'manual') {
      decide(app.db, { ...rule, id, decision: 'defer', rationale: `Not now by rule: ${def.kind} findings wait until a person takes one.` })
    } else pending++
  }
  return pending
}

/** Findings of this repo that wait for the arbiter. */
export function pendingCount(app: App, repo: string): number {
  return (app.db.prepare("SELECT COUNT(*) AS n FROM findings WHERE repo_key = ? AND state = 'open'").get(repo) as { n: number }).n
}

/**
 * One arbitration per repo, after its rounds settle: a queued one absorbs the new trigger and
 * waits again from now (the scheduler's debounce), so a burst of rounds is judged once.
 */
export function enqueueArbitration(app: App, repo: string, trigger: string): void {
  const queued = app.db.prepare("SELECT id FROM queue WHERE job = 'arbitrate' AND repo_key = ? AND state = 'queued'").get(repo) as { id: string } | undefined
  if (queued) {
    app.db.prepare('UPDATE queue SET created_at = ? WHERE id = ?').run(now(), queued.id)
    return
  }
  app.db
    .prepare("INSERT INTO queue (id, job, repo_key, check_kind, scope, tier, trigger, created_at) VALUES (?, 'arbitrate', ?, ?, 'full', 2, ?, ?)")
    .run(newId('q'), repo, ALL_CHECKS, trigger, now())
  app.kick()
}

export interface Precedent {
  id: string
  decision: DecisionKind
  by: 'user' | 'arbiter'
  rationale: string
  at: string
  finding_id: string
  repo_key: string
  check_kind: string
  category: string
  title: string
}

const MAX_PRECEDENTS = 30

/**
 * Past judgements the arbiter weighs, closest first: the candidates' own history, then the same
 * repo + check + category, the same repo + check, the same group + check + category, the fleet's
 * same check + category. A person's decisions before the arbiter's own; newest first within a rank.
 */
export function precedents(app: App, repo: RepoRow, candidates: FindingRow[]): Precedent[] {
  if (!candidates.length) return []
  const checks = [...new Set(candidates.map((c) => c.check_kind))]
  const own = new Set(candidates.map((c) => c.id))
  const rows = app.db
    .prepare(
      `SELECT d.id, d.decision, d.by, d.rationale, d.at, d.finding_id, f.repo_key, f.check_kind, f.category, f.title, r.group_id
         FROM decisions d JOIN findings f ON f.id = d.finding_id JOIN repos r ON r.key = f.repo_key
        WHERE d.by IN ('user','arbiter') AND d.decision != 'reopen' AND f.check_kind IN (${checks.map(() => '?').join(',')})
        ORDER BY d.at DESC LIMIT 500`,
    )
    .all(...checks) as (Precedent & { group_id: string })[]
  const kinds = new Set(candidates.map((c) => `${c.check_kind}|${c.category}`))
  const rank = (p: Precedent & { group_id: string }): number => {
    const same = kinds.has(`${p.check_kind}|${p.category}`)
    if (own.has(p.finding_id)) return 0
    if (p.repo_key === repo.key && same) return 1
    if (p.repo_key === repo.key) return 2
    if (p.group_id === repo.group_id && same) return 3
    if (same) return 4
    return -1
  }
  return rows
    .map((p) => ({ p, r: rank(p) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || (a.p.by === b.p.by ? 0 : a.p.by === 'user' ? -1 : 1) || b.p.at.localeCompare(a.p.at))
    .slice(0, MAX_PRECEDENTS)
    .map(({ p: { group_id: _g, ...p } }) => p)
}

/** Put deferred and declined findings back to be judged again, and queue their repos' arbitration (invariant 12). */
function reopenHeld(app: App, rows: FindingRow[], why: string, trigger: string): number {
  const repos = new Set<string>()
  for (const f of rows) {
    decide(app.db, { id: f.id, decision: 'reopen', by: 'rule', actor: 'lamplighter', rationale: why, checkRevision: app.checks.get(f.check_kind)?.revision })
    repos.add(f.repo_key)
  }
  for (const r of repos) enqueueArbitration(app, r, trigger)
  return rows.length
}

/** Put aside by the arbiter (a rule's deferral does not depend on the policy or on precedents). */
const BY_ARBITER = "(SELECT d.by FROM decisions d WHERE d.finding_id = f.id ORDER BY d.at DESC, d.rowid DESC LIMIT 1) = 'arbiter'"

/** A repo's or a group's policy changed: what the arbiter put aside under the old wording is judged again. */
export function policyChanged(app: App, scope: { repo: string } | { group: string }): number {
  const rows = (
    'repo' in scope
      ? app.db.prepare(`SELECT * FROM findings f WHERE repo_key = ? AND state IN ('deferred','declined') AND ${BY_ARBITER}`).all(scope.repo)
      : app.db
          .prepare(`SELECT f.* FROM findings f JOIN repos r ON r.key = f.repo_key WHERE r.group_id = ? AND f.state IN ('deferred','declined') AND ${BY_ARBITER}`)
          .all(scope.group)
  ) as FindingRow[]
  return reopenHeld(app, rows, 'The policy changed since this was decided.', 'policy')
}

/**
 * Run a settings change, then re-judge the repos where the check's effective admission or lean
 * moved (a repo override can mask a global change). Returns what `change` returned.
 */
export function watchAdmission<T>(app: App, check: string, repos: RepoRow[], change: () => T): T {
  const def = app.checks.get(check)
  if (!def) return change()
  const key = (r: RepoRow) => {
    const s = settingsFor(app, r, def)
    return `${s.admission}|${s.lean}`
  }
  const before = new Map(repos.map((r) => [r.key, key(r)]))
  const out = change()
  for (const r of repos) {
    const fresh = getRepo(app.db, r.key)
    if (key(fresh) !== before.get(r.key)) admissionChanged(app, fresh, check)
  }
  return out
}

/**
 * A check's admission or lean changed on a repo: what that check's findings were put aside under
 * goes back through the rules, and whatever the rules leave goes to the arbiter.
 */
export function admissionChanged(app: App, repo: RepoRow, check: string): void {
  const rows = app.db
    .prepare("SELECT * FROM findings f WHERE repo_key = ? AND check_kind = ? AND state IN ('deferred','declined') AND (SELECT d.by FROM decisions d WHERE d.finding_id = f.id ORDER BY d.at DESC, d.rowid DESC LIMIT 1) IN ('rule','arbiter')")
    .all(repo.key, check) as FindingRow[]
  for (const f of rows) {
    decide(app.db, { id: f.id, decision: 'reopen', by: 'rule', actor: 'lamplighter', rationale: "The check's admission setting changed.", checkRevision: app.checks.get(check)?.revision })
  }
  const open = (app.db.prepare("SELECT id FROM findings WHERE repo_key = ? AND check_kind = ? AND state = 'open'").all(repo.key, check) as { id: string }[]).map((r) => r.id)
  applyRules(app, repo, open)
  const def = app.checks.get(check)
  if (def) maybePropose(app, repo, def)
  if (pendingCount(app, repo.key)) enqueueArbitration(app, repo.key, 'settings')
}

/**
 * A person (or the MCP, which is not one) takes, dismisses or reopens a finding. A person's take or
 * dismissal is a new precedent: the similar findings put aside in that repo are judged again.
 */
export function personDecides(app: App, id: string, decision: 'take' | 'dismiss' | 'reopen', reason: string, caller: string): FindingRow {
  const before = getFinding(app.db, id)
  if (!before) throw Object.assign(new Error(`no finding ${id}`), { statusCode: 404 })
  const def = app.checks.get(before.check_kind)
  const by = decidedBy(caller)
  const fallback = { take: 'Taken by a person.', dismiss: '', reopen: 'Reopened to be judged again.' }[decision]
  const f = decide(app.db, { id, decision, by, actor: caller, rationale: reason.trim() || fallback, checkRevision: def?.revision })
  logEvent(app.db, { code: decision.toUpperCase(), repo: f.repo_key, message: `${f.title} — ${decision} by ${caller}${reason.trim() ? `: ${reason.trim()}` : ''}`, detail: { finding: id } })
  if (by === 'user' && decision !== 'reopen') {
    const siblings = app.db
      .prepare(`SELECT * FROM findings f WHERE repo_key = ? AND check_kind = ? AND category = ? AND id != ? AND state IN ('deferred','declined') AND ${BY_ARBITER}`)
      .all(f.repo_key, f.check_kind, f.category, id) as FindingRow[]
    reopenHeld(app, siblings, `A person ${decision === 'take' ? 'took' : 'dismissed'} a similar finding (${id}).`, 'precedent')
  }
  if (decision === 'reopen') enqueueArbitration(app, f.repo_key, 'reopen')
  if (decision === 'take' && def) maybePropose(app, getRepo(app.db, f.repo_key), def)
  return f
}
