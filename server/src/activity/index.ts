import type { Db } from '../db/index.js'
import { newId, now } from '../db/index.js'

export type ActivityKind = 'proposal-ready' | 'branch-open' | 'pr-open' | 'pushed' | 'held' | 'report' | 'alert'

export interface ActivityRow {
  id: string
  kind: ActivityKind
  repo_key: string | null
  ref_id: string | null
  title: string
  body: string
  url: string | null
  sensitive: number
  state: 'open' | 'resolved'
  resolution: string | null
  reason: string | null
  created_at: string
  resolved_at: string | null
}

export function addItem(
  db: Db,
  i: { kind: ActivityKind; repo?: string; ref?: string; title: string; body?: string; url?: string; sensitive?: boolean },
): ActivityRow {
  const id = newId('a')
  db.prepare('INSERT INTO activity (id, kind, repo_key, ref_id, title, body, url, sensitive, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id, i.kind, i.repo ?? null, i.ref ?? null, i.title, i.body ?? '', i.url ?? null, i.sensitive ? 1 : 0, now(),
  )
  return getItem(db, id)!
}

export function getItem(db: Db, id: string): ActivityRow | undefined {
  return db.prepare('SELECT * FROM activity WHERE id = ?').get(id) as ActivityRow | undefined
}

export function openItemFor(db: Db, refId: string): ActivityRow | undefined {
  return db.prepare("SELECT * FROM activity WHERE ref_id = ? AND state = 'open' ORDER BY created_at DESC LIMIT 1").get(refId) as ActivityRow | undefined
}

export function resolveItem(db: Db, id: string, resolution: string, reason?: string): void {
  db.prepare("UPDATE activity SET state = 'resolved', resolution = ?, reason = ?, resolved_at = ? WHERE id = ? AND state = 'open'").run(resolution, reason ?? null, now(), id)
}

export function resolveFor(db: Db, refId: string, resolution: string, reason?: string): void {
  db.prepare("UPDATE activity SET state = 'resolved', resolution = ?, reason = ?, resolved_at = ? WHERE ref_id = ? AND state = 'open'").run(resolution, reason ?? null, now(), refId)
}

/** Whether an alert with this code is open. */
export function hasOpenAlert(db: Db, code: string): boolean {
  return !!db.prepare("SELECT id FROM activity WHERE kind = 'alert' AND ref_id = ? AND state = 'open'").get(code)
}

/** One open alert per code, so an outage is one item rather than one per round. */
export function openAlert(db: Db, code: string, title: string, body: string): void {
  if (!hasOpenAlert(db, code)) addItem(db, { kind: 'alert', ref: code, title, body })
}

export function listItems(db: Db, f: { state?: 'open' | 'resolved'; repo?: string; limit?: number } = {}): ActivityRow[] {
  const where: string[] = []
  const args: unknown[] = []
  if (f.state) where.push('state = ?'), args.push(f.state)
  if (f.repo) where.push('repo_key = ?'), args.push(f.repo)
  return db
    .prepare(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`)
    .all(...args, Math.min(f.limit ?? 200, 1000)) as ActivityRow[]
}

export function openCount(db: Db, repo: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM activity WHERE repo_key = ? AND state = 'open' AND kind != 'report'").get(repo) as { n: number }).n
}

/** What the model proposed beside what the person decided — the raw material for tightening policy. */
export function recordOverride(db: Db, o: { activity?: string; proposed: unknown; decided: unknown; reason?: string }): void {
  db.prepare('INSERT INTO overrides (id, activity_id, proposed, decided, reason, at) VALUES (?, ?, ?, ?, ?, ?)').run(
    newId('o'), o.activity ?? null, JSON.stringify(o.proposed), JSON.stringify(o.decided), o.reason ?? null, now(),
  )
}
