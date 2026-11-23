import type { App } from '../context.js'
import type { Db } from '../db/index.js'
import { now } from '../db/index.js'
import { logEvent } from '../events.js'
import { addItem, resolveFor } from '../activity/index.js'
import { listRepos } from '../repos/registry.js'
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
 * The check asks, with GETs and one refused empty-blob POST per repo: whose token is it, and may
 * it push to each monitored repository on its forge? A token that is refused, or a repo no
 * credential may push to, opens one alert per forge (`forge.<id>.auth`). No token at all is not a
 * fault: the forge simply reads anonymously, and nothing is alerted.
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

const fullName = (r: RepoRef) => (r.owner ? `${r.owner}/${r.name}` : r.name)
const pushRow = (cred: CredentialRow, repo: string) => authOf(cred).repos?.find((r) => r.repo === repo)

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

// ── write access ────────────────────────────────────────────────────────────────────────

interface Access {
  ok: boolean
  why?: string
  /** The answer waits on a check that has not run yet; delivery lets the push itself decide. */
  pending?: boolean
}

function access(app: App, repo: RepoRef): Access {
  const forge = forgeRow(app.db, repo.forge_id)
  if (forge.kind === 'git') return { ok: true }
  const full = fullName(repo)
  const { cred, via } = credentialFor(app.db, repo)
  if (!cred) return { ok: false, why: `${forge.name} has no credential, so Lamplighter has no write access to ${full}. Add one in Settings → Forges.` }
  const who = `${forge.name} credential “${cred.label}”`
  const auth = authOf(cred)
  if (auth.state === 'unconfigured') return { ok: false, why: `the ${who} has no token, so Lamplighter has no write access to ${full}. Set one in Settings → Forges.` }
  if (auth.state === 'unknown') return { ok: false, why: `the ${who} has not been checked yet.`, pending: true }
  const own = pushRow(cred, full)
  if (own?.push) return { ok: true }
  if (!auth.login) return { ok: false, why: `the ${who} does not work: ${auth.problems.join('; ')}.` }
  if (!own) return { ok: false, why: `write access to ${full} has not been checked yet.`, pending: true }
  const pin = via === 'repo' ? ' (pinned on the repository)' : via === 'group' ? ' (pinned on its group)' : ''
  if (via !== 'default') return { ok: false, why: `the ${who}${pin} (${auth.login}) has no write access to ${full}: ${own.detail ?? 'cannot push'}.` }
  // Auto found nothing: say what each credential answered, so the fix is obvious.
  const tried = listCredentials(app.db, repo.forge_id)
    .filter((c) => c.token)
    .map((c) => {
      const r = pushRow(c, full)
      return `“${c.label}”${authOf(c).login ? ` (${authOf(c).login})` : ''}: ${r ? (r.detail ?? 'cannot push') : 'not checked'}`
    })
  return { ok: false, why: `no ${forge.name} credential may push to ${full} — ${tried.join('; ')}.` }
}

/**
 * May Lamplighter write to this repository? No means the fixing loop is blocked there — no
 * proposal is drafted, validated or delivered, so nothing is authored only to fail at the push.
 * Rounds (read-only) and `report` delivery go on. Bare git cannot be asked, so it is trusted;
 * a credential not yet checked counts as no until the check says otherwise.
 */
export function writeAccess(app: App, repo: RepoRef): { ok: boolean; why?: string } {
  const { ok, why } = access(app, repo)
  return why ? { ok, why } : { ok }
}

/** Delivery's gate: refuse before any git push with a sentence a person can act on. */
export function deliveryBlocker(app: App, repo: RepoRef): string | undefined {
  const a = access(app, repo)
  return a.ok || a.pending ? undefined : a.why
}

export function assertCanDeliver(app: App, repo: RepoRef): void {
  const why = deliveryBlocker(app, repo)
  if (why) throw Object.assign(new Error(why), { statusCode: 409 })
}

/**
 * Who a commit is by: the repo's credential's own name and email when set; else General →
 * identity; else (empty, or the old default `lamplighter@localhost`) a GitHub credential's
 * account, by its noreply address, so the commit is attributed to the account that pushes it.
 */
export function commitIdentity(app: App, repo: RepoRef): { name: string; email: string } {
  const id = app.config.current.identity
  const { cred } = credentialFor(app.db, repo)
  const name = cred?.commit_name || id.name || 'Lamplighter'
  if (cred?.commit_email) return { name, email: cred.commit_email }
  if (id.email && id.email !== 'lamplighter@localhost') return { name, email: id.email }
  const auth = cred ? authOf(cred) : undefined
  if (cred && forgeRow(app.db, repo.forge_id).kind === 'github' && auth?.login && auth.user_id) {
    return { name, email: `${auth.user_id}+${auth.login}@users.noreply.github.com` }
  }
  return { name, email: id.email || 'lamplighter@localhost' }
}

// ── checks ──────────────────────────────────────────────────────────────────────────────

/** Whose token is this, and may it push to each repo on its forge? Records the answer. */
export async function checkCredential(app: App, id: string): Promise<CredentialAuth> {
  const cred = credentialRow(app.db, id)
  const forge = forgeRow(app.db, cred.forge_id)
  const api = forgeApi(forge, cred)
  if (!cred.token || !api.whoami || !api.canPush) {
    app.db.prepare('UPDATE credentials SET auth_json = NULL WHERE id = ?').run(id)
    return authOf(cred)
  }
  const problems: string[] = []
  const auth: CredentialAuth = { state: 'ok', problems, repos: [], checked_at: now() }
  try {
    const me = await api.whoami()
    auth.login = me.login
    auth.user_id = me.id
    // A repo this token cannot push to is not its fault — another credential may reach it.
    for (const r of listRepos(app.db).filter((x) => x.forge_id === forge.id && x.owner)) {
      const p = await api.canPush(r.owner, r.name)
      auth.repos!.push({ repo: `${r.owner}/${r.name}`, push: p.push, ...(p.detail ? { detail: p.detail } : {}) })
    }
  } catch (err) {
    const status = (err as { status?: number }).status
    problems.push(status === 401 ? `${forge.name} refused the token (expired or revoked?)` : `${forge.name} could not be reached: ${(err as Error).message}`)
    auth.state = 'failing'
  }
  // A token swapped while this check was in flight: its answer is about a token nobody has.
  const nowRow = app.db.prepare('SELECT token FROM credentials WHERE id = ?').get(id) as { token: string | null } | undefined
  if (nowRow?.token !== cred.token) return nowRow ? authOf(credentialRow(app.db, id)) : auth
  app.db.prepare('UPDATE credentials SET auth_json = ? WHERE id = ?').run(JSON.stringify(auth), id)
  return auth
}

const alertCode = (id: string) => `forge.${id}.auth`

/** One alert per forge: a refused token, or a repo no credential may push to. */
export function forgeAlert(app: App, forgeId: string): void {
  const forge = forgeRow(app.db, forgeId)
  const creds = listCredentials(app.db, forgeId).filter((c) => c.token)
  if (forge.kind === 'git' || !creds.length) {
    resolveFor(app.db, alertCode(forgeId), 'resolved', 'the forge has no token')
    return
  }
  const problems = creds.filter((c) => authOf(c).state === 'failing').map((c) => `“${c.label}”: ${authOf(c).problems.join('; ')}`)
  for (const r of listRepos(app.db).filter((x) => x.forge_id === forgeId && x.owner)) {
    const a = access(app, r)
    if (!a.ok && !a.pending && a.why) problems.push(a.why)
  }
  const open = app.db.prepare("SELECT id FROM activity WHERE kind = 'alert' AND ref_id = ? AND state = 'open'").get(alertCode(forgeId))
  if (problems.length && !open) {
    addItem(app.db, {
      kind: 'alert', ref: alertCode(forgeId),
      title: `Lamplighter cannot write everywhere on ${forge.name}`,
      body: `${problems.join(' ')} Nothing can be delivered there until it is fixed in Settings → Forges; rounds still run.`,
    })
  } else if (!problems.length) {
    resolveFor(app.db, alertCode(forgeId), 'resolved', 'every credential works and every repo has one that may push')
  }
}

/** Every credential on the forge re-checked, then its alert. */
export async function checkForge(app: App, forgeId: string): Promise<void> {
  for (const c of listCredentials(app.db, forgeId).filter((x) => x.token)) await checkCredential(app, c.id).catch(() => undefined)
  forgeAlert(app, forgeId)
}

/** Every forge, re-checked — on boot and then periodically from the scheduler. */
export async function checkAllForges(app: App): Promise<void> {
  const ids = (app.db.prepare("SELECT id FROM forges WHERE kind != 'git'").all() as { id: string }[]).map((r) => r.id)
  for (const id of ids) await checkForge(app, id).catch(() => undefined)
}

/** Set (or clear, `null`) a credential's token, and check it in the same call. Never logs the token. */
export async function setCredentialToken(app: App, id: string, token: string | null, by: string): Promise<CredentialAuth> {
  const cred = credentialRow(app.db, id)
  app.db.prepare('UPDATE credentials SET token = ?, token_set_at = ?, auth_json = NULL WHERE id = ?').run(token, token ? now() : null, id)
  logEvent(app.db, { level: 'warn', code: token ? 'FORGE_TOKEN_SET' : 'FORGE_TOKEN_CLEARED', message: `${cred.forge_id}/${cred.label}: token ${token ? 'set' : 'cleared'} by ${by}`, detail: { forge: cred.forge_id, credential: id } })
  const auth = await checkCredential(app, id)
  forgeAlert(app, cred.forge_id)
  return auth
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
export function addCredential(app: App, forgeId: string, input: CredentialInput & { label: string }): CredentialRow {
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

export function patchCredential(app: App, id: string, input: CredentialInput): CredentialRow {
  credentialRow(app.db, id)
  for (const col of ['label', 'username', 'commit_name', 'commit_email'] as const) {
    if (input[col] !== undefined) app.db.prepare(`UPDATE credentials SET ${col} = ? WHERE id = ?`).run(input[col] || (col === 'label' ? id : null), id)
  }
  if (input.is_default) makeDefault(app.db, id)
  return credentialRow(app.db, id)
}

/** Remove a credential; repos and groups pinned to it fall back to auto. */
export function removeCredential(app: App, id: string, by: string): void {
  const cred = credentialRow(app.db, id)
  app.db.prepare('DELETE FROM credentials WHERE id = ?').run(id)
  if (cred.is_default) {
    const next = listCredentials(app.db, cred.forge_id)[0]
    if (next) makeDefault(app.db, next.id)
  }
  logEvent(app.db, { level: 'warn', code: 'FORGE_CREDENTIAL_REMOVED', message: `${cred.forge_id}/${cred.label}: removed by ${by}`, detail: { forge: cred.forge_id, credential: id } })
  forgeAlert(app, cred.forge_id)
}

function makeDefault(db: Db, id: string): void {
  const cred = credentialRow(db, id)
  db.prepare('UPDATE credentials SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE forge_id = ?').run(id, cred.forge_id)
}

/** Pin (or unpin, `null`) a repo's or group's credential — from Settings only. */
export function assertPinnable(db: Db, credentialId: string | null, forgeId?: string): void {
  if (credentialId === null) return
  const cred = credentialRow(db, credentialId)
  if (forgeId && cred.forge_id !== forgeId) throw Object.assign(new Error(`credential “${cred.label}” is on ${cred.forge_id}, not ${forgeId}`), { statusCode: 400 })
}
