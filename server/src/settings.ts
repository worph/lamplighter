import { randomBytes } from 'node:crypto'
import type { Db } from './db/index.js'

/** Secrets and small runtime state. Never shown back in full — see `masked`. */
export const SETTING = {
  adminMcpToken: 'admin_mcp_token',
  inferenceBearer: 'inference_bearer',
} as const

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSetting(db: Db, key: string, value: string | null): void {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

export function getOrCreateSecret(db: Db, key: string, seed?: string): string {
  const existing = getSetting(db, key)
  if (existing) return existing
  const value = seed ?? randomBytes(24).toString('base64url')
  setSetting(db, key, value)
  return value
}

export function masked(secret: string | undefined | null): string | null {
  if (!secret) return null
  return secret.length <= 8 ? '••••' : `${secret.slice(0, 4)}…${secret.slice(-2)}`
}
