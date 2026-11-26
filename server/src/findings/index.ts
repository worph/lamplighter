import { createHash } from 'node:crypto'
import type { Db } from '../db/index.js'
import { newId, now } from '../db/index.js'
import { git } from '../forges/gitcli.js'

/** A finding as a round reports it (a model's `record_finding`, or a detector), before reconcile. */
export interface RecordedFinding {
  category: string
  anchor: string
  title: string
  body: string
  severity: 'critical' | 'major' | 'minor'
  existing_id?: string
}

/**
 * `open` is raised and not judged yet; admission (§6.4) moves it to `admitted` (work), `deferred`
 * (not now) or `declined`. Only an admitted finding enters a proposal.
 */
export type FindingState = 'open' | 'admitted' | 'deferred' | 'declined' | 'dismissed' | 'proposed' | 'fixed' | 'gone'
export const FINDING_STATES: FindingState[] = ['open', 'admitted', 'deferred', 'declined', 'dismissed', 'proposed', 'fixed', 'gone']

export type DecisionKind = 'admit' | 'defer' | 'decline' | 'dismiss' | 'take' | 'reopen'
export type DecidedBy = 'rule' | 'arbiter' | 'user' | 'mcp'

/** What each decision leaves the finding as. */
const AFTER: Record<DecisionKind, FindingState> = {
  admit: 'admitted', take: 'admitted', defer: 'deferred', decline: 'declined', dismiss: 'dismissed', reopen: 'open',
}

/** Which states a decision may be taken from: admission judges what is open; a person may take back what was put aside. */
const FROM: Record<DecisionKind, FindingState[]> = {
  admit: ['open'],
  defer: ['open'],
  decline: ['open'],
  take: ['open', 'deferred', 'declined', 'dismissed'],
  dismiss: ['open', 'admitted', 'deferred', 'declined'],
  reopen: ['admitted', 'deferred', 'declined', 'dismissed', 'gone', 'fixed'],
}

export interface DecisionRow {
  id: string
  finding_id: string
  decision: DecisionKind
  by: DecidedBy
  actor: string
  rationale: string
  precedents: string
  input_hash: string
  check_revision: number
  session_id: string | null
  at: string
}

export interface FindingRow {
  id: string
  repo_key: string
  check_kind: string
  fingerprint: string
  category: string
  anchor: string
  title: string
  body: string
  severity: string
  sensitive: number
  input_hash: string
  state: FindingState
  first_round: string
  last_round: string
  proposal_id: string | null
  blocked_input: string | null
  source: string
  source_ref: string | null
  created_at: string
  updated_at: string
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 24)

/** The path part of an anchor: `src/a.ts#foo` → `src/a.ts`, `src/a.ts:12-20` → `src/a.ts`. */
export function anchorPath(anchor: string): string {
  return anchor.split('#')[0]!.replace(/:\d+(-\d+)?$/, '').trim()
}

/** Line numbers move, case drifts; the identity is check + category + what it is about. */
export function fingerprint(check: string, category: string, anchor: string): string {
  const a = anchor.trim().toLowerCase().replace(/:\d+(-\d+)?(?=#|$)/, '').replace(/\s+/g, ' ')
  return sha(`${check}|${category}|${a}`)
}

/**
 * What a finding is *about*, as bytes: the blob id of its file at the reviewed commit, or the
 * anchor itself when it is not a file (a package, a module). A dismissal holds while this holds.
 */
export async function inputHash(worktree: string, commit: string, anchor: string): Promise<string> {
  const p = anchorPath(anchor)
  if (p && !p.includes(':')) {
    try {
      return (await git(['rev-parse', `${commit}:${p}`], { cwd: worktree })).trim()
    } catch {
      /* not a file at that commit */
    }
  }
  return sha(`anchor|${anchor}`)
}

export function getFinding(db: Db, id: string): FindingRow | undefined {
  return db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as FindingRow | undefined
}

export function listFindings(db: Db, f: { repo?: string; check?: string; state?: string; limit?: number } = {}): FindingRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.repo) where.push('repo_key = ?'), args.push(f.repo)
  if (f.check) where.push('check_kind = ?'), args.push(f.check)
  if (f.state) where.push('state = ?'), args.push(f.state)
  const sql = `SELECT * FROM findings ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'admitted' THEN 0 WHEN 'proposed' THEN 1 WHEN 'deferred' THEN 2 WHEN 'declined' THEN 2 WHEN 'dismissed' THEN 3 ELSE 4 END,
      CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`
  return db.prepare(sql).all(...args, Math.min(f.limit ?? 500, 2000)) as FindingRow[]
}

export interface ReconcileResult {
  ids: string[]
  created: number
  updated: number
  reopened: number
  stillDismissed: number
  /** Deferred or declined, re-raised against the same facts: the decision stands (invariant 12). */
  held: number
  gone: number
}

const DAY_MS = 86_400_000

/**
 * Fold one round's findings into the table. Same fingerprint (or the `existing_id` the model gave)
 * is the same finding; a dismissed one stays dismissed unless its input changed (invariant 7), and a
 * deferred or declined one stays so unless its input, the check's revision or the check's cadence
 * moved past its decision (invariant 12). A full round is authoritative for its check: what it no
 * longer raises is gone, among the findings rounds raised (an issue's are its own).
 */
export async function reconcile(
  db: Db,
  args: {
    repo: string; check: string; revision: number; cadenceDays: number; roundId: string; scope: 'diff' | 'full'; sensitive: boolean
    worktree: string; commit: string; recorded: RecordedFinding[]
  },
): Promise<ReconcileResult> {
  const r: ReconcileResult = { ids: [], created: 0, updated: 0, reopened: 0, stillDismissed: 0, held: 0, gone: 0 }
  const t = now()
  for (const f of args.recorded) {
    const fp = fingerprint(args.check, f.category, f.anchor)
    const hash = await inputHash(args.worktree, args.commit, f.anchor)
    let existing: FindingRow | undefined
    if (f.existing_id) {
      const byId = getFinding(db, f.existing_id)
      if (byId && byId.repo_key === args.repo && byId.check_kind === args.check) existing = byId
    }
    existing ??= db.prepare('SELECT * FROM findings WHERE repo_key = ? AND check_kind = ? AND fingerprint = ?').get(args.repo, args.check, fp) as
      | FindingRow
      | undefined
    if (!existing) {
      const id = newId('f')
      db.prepare(
        `INSERT INTO findings (id, repo_key, check_kind, fingerprint, category, anchor, title, body, severity, sensitive, input_hash, state, first_round, last_round, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      ).run(id, args.repo, args.check, fp, f.category, f.anchor, f.title, f.body, f.severity, args.sensitive ? 1 : 0, hash, args.roundId, args.roundId, t, t)
      r.ids.push(id)
      r.created++
      continue
    }
    r.ids.push(existing.id)
    const refresh = (state: FindingState) =>
      db.prepare('UPDATE findings SET state = ?, title = ?, body = ?, severity = ?, input_hash = ?, last_round = ?, updated_at = ? WHERE id = ?').run(
        state, f.title, f.body, f.severity, hash, args.roundId, t, existing.id,
      )
    if (existing.state === 'dismissed' || existing.state === 'deferred' || existing.state === 'declined') {
      const d = lastDecision(db, existing.id)
      const why = !d || d.input_hash !== hash
        ? 'what it is about changed'
        : existing.state !== 'dismissed' && d.check_revision < args.revision
          ? 'the check was revised'
          : existing.state !== 'dismissed' && Date.now() - Date.parse(d.at) > args.cadenceDays * DAY_MS
            ? "the check's cadence passed"
            : undefined
      if (!why) {
        db.prepare('UPDATE findings SET last_round = ? WHERE id = ?').run(args.roundId, existing.id)
        if (existing.state === 'dismissed') r.stillDismissed++
        else r.held++
        continue
      }
      refresh('open')
      insertDecision(db, { id: existing.id, decision: 'reopen', by: 'rule', actor: 'lamplighter', rationale: `Raised again: ${why}.`, inputHash: hash, checkRevision: args.revision })
      r.reopened++
      continue
    }
    const state = existing.state === 'gone' || existing.state === 'fixed' ? 'open' : existing.state
    if (state !== existing.state) r.reopened++
    else r.updated++
    refresh(state)
  }
  if (args.scope === 'full') {
    const seen = new Set(r.ids)
    const left = db
      .prepare("SELECT id FROM findings WHERE repo_key = ? AND check_kind = ? AND source = 'round' AND state IN ('open','admitted','deferred','declined')")
      .all(args.repo, args.check) as { id: string }[]
    for (const { id } of left) {
      if (seen.has(id)) continue
      db.prepare("UPDATE findings SET state = 'gone', updated_at = ? WHERE id = ?").run(t, id)
      r.gone++
    }
  }
  return r
}

function insertDecision(
  db: Db,
  d: { id: string; decision: DecisionKind; by: DecidedBy; actor: string; rationale: string; inputHash: string; checkRevision: number; precedents?: string[]; session?: string },
): void {
  db.prepare(
    `INSERT INTO decisions (id, finding_id, decision, by, actor, rationale, precedents, input_hash, check_revision, session_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId('d'), d.id, d.decision, d.by, d.actor, d.rationale, JSON.stringify(d.precedents ?? []), d.inputHash, d.checkRevision, d.session ?? null, now())
}

export class DecisionError extends Error {}

/**
 * The one way a finding is judged: a decision row, and the state it leaves the finding in. A person
 * may dismiss, take back or reopen; rules and the arbiter only judge what is open, and nobody but a
 * person puts a sensitive finding aside for good (§6.4).
 */
export function decide(
  db: Db,
  d: { id: string; decision: DecisionKind; by: DecidedBy; actor: string; rationale: string; checkRevision?: number; precedents?: string[]; session?: string },
): FindingRow {
  const f = getFinding(db, d.id)
  if (!f) throw new DecisionError(`no finding ${d.id}`)
  if (!FROM[d.decision].includes(f.state)) throw new DecisionError(`a ${f.state} finding cannot be given "${d.decision}"`)
  if ((d.decision === 'dismiss' || d.by === 'arbiter') && !d.rationale.trim()) throw new DecisionError(`a ${d.decision} needs a reason`)
  if (d.decision === 'decline' && f.sensitive && d.by !== 'user') throw new DecisionError('a sensitive finding is not declined: defer it, so a person sees it')
  db.transaction(() => {
    insertDecision(db, { ...d, rationale: d.rationale.trim(), inputHash: f.input_hash, checkRevision: d.checkRevision ?? 0 })
    db.prepare('UPDATE findings SET state = ?, proposal_id = CASE WHEN ? THEN NULL ELSE proposal_id END, updated_at = ? WHERE id = ?').run(
      AFTER[d.decision], d.decision === 'reopen' ? 1 : 0, now(), d.id,
    )
  })()
  return getFinding(db, d.id)!
}

/** Who calls is who decides: the MCP is not a person (invariant 9). */
export function decidedBy(caller: string): DecidedBy {
  return caller === 'mcp' ? 'mcp' : 'user'
}

export function dismiss(db: Db, id: string, reason: string, by: string): FindingRow {
  return decide(db, { id, decision: 'dismiss', by: decidedBy(by), actor: by, rationale: reason })
}

export function lastDecision(db: Db, id: string): DecisionRow | undefined {
  return db.prepare('SELECT * FROM decisions WHERE finding_id = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(id) as DecisionRow | undefined
}

export function decisionsOf(db: Db, id: string): DecisionRow[] {
  return db.prepare('SELECT * FROM decisions WHERE finding_id = ? ORDER BY at DESC, rowid DESC LIMIT 50').all(id) as DecisionRow[]
}

// ── proposal-driven transitions (§6.2): admitted → proposed → fixed | back to admitted ───────────────

/** A proposal took these findings on. */
export function markProposed(db: Db, ids: string[], proposalId: string, t: string = now()): void {
  const mark = db.prepare("UPDATE findings SET state = 'proposed', proposal_id = ?, updated_at = ? WHERE id = ?")
  for (const id of ids) mark.run(proposalId, t, id)
}

/** The proposal landed: its finding is fixed (only while that proposal still holds it). */
export function markFixed(db: Db, id: string, proposalId: string, t: string = now()): void {
  db.prepare("UPDATE findings SET state = 'fixed', updated_at = ? WHERE id = ? AND proposal_id = ?").run(t, id, proposalId)
}

/**
 * Hand a finding back to admitted: the work was wanted, this attempt was not. `block` remembers that this input was tried (invariant 7), so it
 * is not proposed again until what it is about changes. With `proposalId`, only while that
 * proposal still holds it.
 */
export function returnToAdmitted(db: Db, id: string, opts: { proposalId?: string; block: boolean; t?: string }): void {
  const blocked = opts.block ? 'input_hash' : 'blocked_input'
  const t = opts.t ?? now()
  if (opts.proposalId !== undefined) {
    db.prepare(`UPDATE findings SET state = 'admitted', proposal_id = NULL, blocked_input = ${blocked}, updated_at = ? WHERE id = ? AND proposal_id = ?`).run(t, id, opts.proposalId)
  } else {
    db.prepare(`UPDATE findings SET state = 'admitted', proposal_id = NULL, blocked_input = ${blocked}, updated_at = ? WHERE id = ?`).run(t, id)
  }
}
