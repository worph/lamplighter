import type { Db } from '../db/index.js'
import { now } from '../db/index.js'
import { credentialRow, forgeApi, forgeRow, listCredentials } from './index.js'
import type { CredentialAuth, CredentialRow, ForgeApi, ForgeRow } from './types.js'

/**
 * Forge credentials, the way Touchstone keeps its GitHub token — several per forge. Each is set
 * from the Settings page and **write-only**: no route returns a token, only when it was set and
 * what the check made of it. Which credential a repo uses is chosen there too, never from the
 * chat or the admin MCP: a choice made by a surface that authenticates nobody is a push under
 * somebody else's name.
 *
 * A repo's credential, first match wins:
 *   1. pinned on the repo;
 *   2. pinned on its group (when that credential is on the repo's forge);
 *   3. auto: a credential whose last check says it may push there, the forge's default first;
 *   4. the forge's default, which then reads but cannot push.
 * One fine-grained GitHub token reaches one owner, so "one credential per owner" needs no pins.
 *
 * This file is credential resolution only, and depends on `db` and `forges/` alone. Checking
 * the credentials against the fleet, the alert that follows and the delivery gate are in
 * `repos/access.ts`.
 */

const MAX_TOKEN_CHARS = 512

export class TokenInvalid extends Error {
  readonly statusCode = 400
  constructor(message: string) {
    super(message)
    this.name = 'TokenInvalid'
  }
}

/** Trimmed, single-line, printable ASCII — or a refusal saying which of those it is not. */
export function normalizeToken(raw: unknown): string {
  if (typeof raw !== 'string') throw new TokenInvalid('token is required')
  const token = raw.trim()
  if (!token) throw new TokenInvalid('token is empty')
  if (token.length > MAX_TOKEN_CHARS) throw new TokenInvalid('that is too long to be a token')
  if (!/^[\x21-\x7e]+$/.test(token)) throw new TokenInvalid('a token is one word of printable ASCII — no spaces or line breaks')
  return token
}

export function authOf(cred: CredentialRow): CredentialAuth {
  if (!cred.token) return { state: 'unconfigured', problems: [] }
  if (!cred.auth_json) return { state: 'unknown', problems: [] }
  try {
    return JSON.parse(cred.auth_json) as CredentialAuth
  } catch {
    return { state: 'unknown', problems: [] }
  }
}

/** What the Settings page may see of a credential: everything but its token. */
export function credentialView(cred: CredentialRow) {
  return {
    id: cred.id,
    forge_id: cred.forge_id,
    label: cred.label,
    username: cred.username,
    commit_name: cred.commit_name,
    commit_email: cred.commit_email,
    is_default: !!cred.is_default,
    created_at: cred.created_at,
    token_set: !!cred.token,
    token_set_at: cred.token_set_at,
    auth: authOf(cred),
  }
}

/** What the Settings page may see of a forge: everything but its secrets. */
export function forgeView(db: Db, row: ForgeRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    base_url: row.base_url,
    created_at: row.created_at,
    webhook_secret: row.webhook_secret ? '••••' : null,
    credentials: listCredentials(db, row.id).map(credentialView),
  }
}

// ── which credential a repo uses ─────────────────────────────────────────────────────────

export type CredentialVia = 'repo' | 'group' | 'auto' | 'default'

/** Enough of a repo row to choose its credential. */
export interface RepoRef {
  forge_id: string
  owner: string | null
  name: string
  group_id?: string
  credential_id?: string | null
}

export const fullName = (r: RepoRef) => (r.owner ? `${r.owner}/${r.name}` : r.name)
export const pushRow = (cred: CredentialRow, repo: string) => authOf(cred).repos?.find((r) => r.repo === repo)

export function credentialFor(db: Db, repo: RepoRef): { cred: CredentialRow | null; via?: CredentialVia } {
  const onForge = (id: string | null | undefined) => {
    if (!id) return undefined
    const c = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow | undefined
    return c && c.forge_id === repo.forge_id ? c : undefined
  }
  const pinned = onForge(repo.credential_id)
  if (pinned) return { cred: pinned, via: 'repo' }
  if (repo.group_id) {
    const g = db.prepare('SELECT credential_id FROM groups WHERE id = ?').get(repo.group_id) as { credential_id: string | null } | undefined
    const viaGroup = onForge(g?.credential_id)
    if (viaGroup) return { cred: viaGroup, via: 'group' }
  }
  const all = listCredentials(db, repo.forge_id)
  const full = fullName(repo)
  const pushes = all.find((c) => c.token && authOf(c).state === 'ok' && pushRow(c, full)?.push)
  if (pushes) return { cred: pushes, via: 'auto' }
  const fallback = all.find((c) => c.is_default) ?? all.find((c) => c.token) ?? all[0]
  return fallback ? { cred: fallback, via: 'default' } : { cred: null }
}

/** The forge's REST side as the repo's credential sees it. */
export function apiFor(db: Db, repo: RepoRef): ForgeApi {
  return forgeApi(forgeRow(db, repo.forge_id), credentialFor(db, repo).cred)
}

/**
 * Try `fn` as each of the forge's credentials (default first), then anonymously when it has
 * none, until one answers. For a repo not yet enrolled, whose credential cannot be chosen yet.
 */
export async function asAnyCredential<T>(db: Db, forgeId: string, fn: (api: ForgeApi) => Promise<T>): Promise<T> {
  const forge = forgeRow(db, forgeId)
  const creds = listCredentials(db, forgeId).filter((c) => c.token)
  let last: unknown
  for (const cred of creds.length ? creds : [null]) {
    try {
      return await fn(forgeApi(forge, cred))
    } catch (err) {
      last = err
    }
  }
  throw last
}

export interface CredentialInput {
  label?: string
  username?: string | null
  commit_name?: string | null
  commit_email?: string | null
  is_default?: boolean
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'cred'

/** A new credential on a forge, with no token yet. The forge's first is its default. */
export function addCredential(app: { db: Db }, forgeId: string, input: CredentialInput & { label: string }): CredentialRow {
  const forge = forgeRow(app.db, forgeId)
  if (forge.kind === 'git') throw Object.assign(new Error('a bare git forge authenticates with the container’s SSH key, not a token'), { statusCode: 400 })
  let id = `${forgeId}-${slug(input.label)}`
  for (let n = 2; app.db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id); n++) id = `${forgeId}-${slug(input.label)}-${n}`
  const first = !listCredentials(app.db, forgeId).length
  app.db
    .prepare('INSERT INTO credentials (id, forge_id, label, username, commit_name, commit_email, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, forgeId, input.label, input.username || null, input.commit_name || null, input.commit_email || null, now())
  if (first || input.is_default) makeDefault(app.db, id)
  return credentialRow(app.db, id)
}

export function patchCredential(app: { db: Db }, id: string, input: CredentialInput): CredentialRow {
  credentialRow(app.db, id)
  for (const col of ['label', 'username', 'commit_name', 'commit_email'] as const) {
    if (input[col] !== undefined) app.db.prepare(`UPDATE credentials SET ${col} = ? WHERE id = ?`).run(input[col] || (col === 'label' ? id : null), id)
  }
  if (input.is_default) makeDefault(app.db, id)
  return credentialRow(app.db, id)
}

export function makeDefault(db: Db, id: string): void {
  const cred = credentialRow(db, id)
  db.prepare('UPDATE credentials SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE forge_id = ?').run(id, cred.forge_id)
}

/** Pin (or unpin, `null`) a repo's or group's credential — from Settings only. */
export function assertPinnable(db: Db, credentialId: string | null, forgeId?: string): void {
  if (credentialId === null) return
  const cred = credentialRow(db, credentialId)
  if (forgeId && cred.forge_id !== forgeId) throw Object.assign(new Error(`credential “${cred.label}” is on ${cred.forge_id}, not ${forgeId}`), { statusCode: 400 })
}
