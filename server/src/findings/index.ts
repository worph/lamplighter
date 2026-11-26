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

export type FindingState = 'open' | 'dismissed' | 'proposed' | 'fixed' | 'gone'

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
    ORDER BY CASE state WHEN 'open' THEN 0 WHEN 'proposed' THEN 1 WHEN 'dismissed' THEN 2 ELSE 3 END,
      CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, updated_at DESC LIMIT ?`
  return db.prepare(sql).all(...args, Math.min(f.limit ?? 500, 2000)) as FindingRow[]
}

export interface ReconcileResult {
  ids: string[]
  created: number
  updated: number
  reopened: number
  stillDismissed: number
  gone: number
}

/**
 * Fold one round's findings into the table. Same fingerprint (or the `existing_id` the model gave)
 * is the same finding; a dismissed one stays dismissed unless its input changed (invariant 7).
 * A full round is authoritative for its check: open findings it did not raise are gone.
 */
export async function reconcile(
  db: Db,
  args: { repo: string; check: string; roundId: string; scope: 'diff' | 'full'; sensitive: boolean; worktree: string; commit: string; recorded: RecordedFinding[] },
): Promise<ReconcileResult> {
  const r: ReconcileResult = { ids: [], created: 0, updated: 0, reopened: 0, stillDismissed: 0, gone: 0 }
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
    if (existing.state === 'dismissed') {
      const d = db.prepare('SELECT input_hash FROM dismissals WHERE finding_id = ? ORDER BY at DESC LIMIT 1').get(existing.id) as { input_hash: string } | undefined
      if (d && d.input_hash === hash) {
        db.prepare('UPDATE findings SET last_round = ? WHERE id = ?').run(args.roundId, existing.id)
        r.stillDismissed++
        continue
      }
      db.prepare("UPDATE findings SET state = 'open', title = ?, body = ?, severity = ?, input_hash = ?, last_round = ?, updated_at = ? WHERE id = ?").run(
        f.title, f.body, f.severity, hash, args.roundId, t, existing.id,
      )
      r.reopened++
      continue
    }
    const state = existing.state === 'gone' || existing.state === 'fixed' ? 'open' : existing.state
    if (state !== existing.state) r.reopened++
    else r.updated++
    db.prepare('UPDATE findings SET state = ?, title = ?, body = ?, severity = ?, input_hash = ?, last_round = ?, updated_at = ? WHERE id = ?').run(
      state, f.title, f.body, f.severity, hash, args.roundId, t, existing.id,
    )
  }
  if (args.scope === 'full') {
    const seen = new Set(r.ids)
    const open = db.prepare("SELECT id FROM findings WHERE repo_key = ? AND check_kind = ? AND state = 'open'").all(args.repo, args.check) as { id: string }[]
    for (const { id } of open) {
      if (seen.has(id)) continue
      db.prepare("UPDATE findings SET state = 'gone', updated_at = ? WHERE id = ?").run(t, id)
      r.gone++
    }
  }
  return r
}

export function dismiss(db: Db, id: string, reason: string, by: string): FindingRow {
  const f = getFinding(db, id)
  if (!f) throw new Error(`no finding ${id}`)
  if (!reason.trim()) throw new Error('a dismissal needs a reason')
  db.prepare('INSERT INTO dismissals (finding_id, reason, input_hash, by, at) VALUES (?, ?, ?, ?, ?)').run(id, reason.trim(), f.input_hash, by, now())
  db.prepare("UPDATE findings SET state = 'dismissed', updated_at = ? WHERE id = ?").run(now(), id)
  return getFinding(db, id)!
}

export function reopen(db: Db, id: string): FindingRow {
  const f = getFinding(db, id)
  if (!f) throw new Error(`no finding ${id}`)
  db.prepare("UPDATE findings SET state = 'open', proposal_id = NULL, updated_at = ? WHERE id = ?").run(now(), id)
  return getFinding(db, id)!
}

export function lastDismissal(db: Db, id: string): { reason: string; by: string; at: string } | undefined {
  return db.prepare('SELECT reason, by, at FROM dismissals WHERE finding_id = ? ORDER BY at DESC LIMIT 1').get(id) as
    | { reason: string; by: string; at: string }
    | undefined
}

// ── proposal-driven transitions (§6.2): open → proposed → fixed | back to open ───────────────

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
 * Hand a finding back to open. `block` remembers that this input was tried (invariant 7), so it
 * is not proposed again until what it is about changes. With `proposalId`, only while that
 * proposal still holds it.
 */
export function returnToOpen(db: Db, id: string, opts: { proposalId?: string; block: boolean; t?: string }): void {
  const blocked = opts.block ? 'input_hash' : 'blocked_input'
  const t = opts.t ?? now()
  if (opts.proposalId !== undefined) {
    db.prepare(`UPDATE findings SET state = 'open', proposal_id = NULL, blocked_input = ${blocked}, updated_at = ? WHERE id = ? AND proposal_id = ?`).run(t, id, opts.proposalId)
  } else {
    db.prepare(`UPDATE findings SET state = 'open', proposal_id = NULL, blocked_input = ${blocked}, updated_at = ? WHERE id = ?`).run(t, id)
  }
}
