import type { Db } from './db/index.js'
import { now } from './db/index.js'

export type Level = 'info' | 'warn' | 'error'

export interface EventRow {
  id: number
  at: string
  level: Level
  code: string
  repo_key: string | null
  message: string
  detail: string | null
}

/** The operations log. Every state change worth explaining later writes one row. */
export function logEvent(
  db: Db,
  e: { level?: Level; code: string; repo?: string | null; message: string; detail?: unknown },
): void {
  db.prepare('INSERT INTO events (at, level, code, repo_key, message, detail) VALUES (?, ?, ?, ?, ?, ?)').run(
    now(),
    e.level ?? 'info',
    e.code,
    e.repo ?? null,
    e.message,
    e.detail === undefined ? null : typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail),
  )
}

export function listEvents(db: Db, opts: { limit?: number; repo?: string } = {}): EventRow[] {
  const limit = Math.min(opts.limit ?? 100, 500)
  if (opts.repo) {
    return db.prepare('SELECT * FROM events WHERE repo_key = ? ORDER BY id DESC LIMIT ?').all(opts.repo, limit) as EventRow[]
  }
  return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit) as EventRow[]
}
