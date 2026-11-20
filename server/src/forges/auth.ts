import type { App } from '../context.js'
import { now } from '../db/index.js'
import { logEvent } from '../events.js'
import { addItem, resolveFor } from '../activity/index.js'
import { listRepos } from '../repos/registry.js'
import { forgeApi, forgeRow } from './index.js'
import type { ForgeAuth, ForgeRow } from './types.js'

/**
 * A forge's token, the way Touchstone keeps its GitHub token: set from the Settings page and
 * **write-only** — no route returns it, only when it was set and what the check made of it — and
 * deliberately not reachable from the chat or the admin MCP: a token chosen by a surface that
 * authenticates nobody is a push under somebody else's name.
 *
 * The check asks, with GETs and one refused empty-blob POST per repo: whose token is it, and may
 * it push to each monitored repository on this forge? Anything blocking opens one alert per
 * forge (`forge.<id>.auth`), and delivery refuses to start until it closes. No token is not a
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

export function authOf(row: ForgeRow): ForgeAuth {
  if (row.kind === 'git') return { state: 'unconfigured', problems: [] }
  if (!row.token) return { state: 'unconfigured', problems: [] }
  if (!row.auth_json) return { state: 'unknown', problems: [] }
  try {
    return JSON.parse(row.auth_json) as ForgeAuth
  } catch {
    return { state: 'unknown', problems: [] }
  }
}

/** What the Settings page may see of a forge: everything but its secrets. */
export function forgeView(row: ForgeRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    base_url: row.base_url,
    username: row.username,
    created_at: row.created_at,
    token_set: !!row.token,
    token_set_at: row.token_set_at,
    webhook_secret: row.webhook_secret ? '••••' : null,
    auth: authOf(row),
    repos: [] as string[],
  }
}

const alertCode = (id: string) => `forge.${id}.auth`

export async function checkForge(app: App, id: string): Promise<ForgeAuth> {
  const row = forgeRow(app.db, id)
  const api = forgeApi(row)
  if (row.kind === 'git' || !row.token || !api.whoami || !api.canPush) {
    app.db.prepare('UPDATE forges SET auth_json = NULL WHERE id = ?').run(id)
    resolveFor(app.db, alertCode(id), 'resolved', 'the forge has no token')
    return authOf(row)
  }
  const problems: string[] = []
  const auth: ForgeAuth = { state: 'ok', problems, repos: [], checked_at: now() }
  try {
    const me = await api.whoami()
    auth.login = me.login
    auth.user_id = me.id
    for (const r of listRepos(app.db).filter((x) => x.forge_id === id && x.owner)) {
      const p = await api.canPush(r.owner!, r.name)
      auth.repos!.push({ repo: `${r.owner}/${r.name}`, push: p.push, ...(p.detail ? { detail: p.detail } : {}) })
      if (!p.push) problems.push(`${r.owner}/${r.name}: ${p.detail ?? 'cannot push'}`)
    }
  } catch (err) {
    const status = (err as { status?: number }).status
    problems.push(status === 401 ? `${row.name} refused the token (expired or revoked?)` : `${row.name} could not be reached: ${(err as Error).message}`)
  }
  // A token swapped while this check was in flight: its answer is about a token nobody has.
  if (forgeRow(app.db, id).token !== row.token) return authOf(forgeRow(app.db, id))
  if (problems.length) auth.state = 'failing'
  app.db.prepare('UPDATE forges SET auth_json = ? WHERE id = ?').run(JSON.stringify(auth), id)
  const open = app.db.prepare("SELECT id FROM activity WHERE kind = 'alert' AND ref_id = ? AND state = 'open'").get(alertCode(id))
  if (problems.length && !open) {
    addItem(app.db, { kind: 'alert', ref: alertCode(id), title: `Lamplighter cannot use the ${row.name} token`, body: `${problems.join('; ')}. Nothing can be delivered there until it is fixed in Settings → Forges; rounds still run.` })
  } else if (!problems.length) {
    resolveFor(app.db, alertCode(id), 'resolved', 'the token works')
  }
  return auth
}

/** Set (or clear, `null`) a forge's token, and check it in the same call. Never logs the token. */
export async function setForgeToken(app: App, id: string, token: string | null, by: string): Promise<ForgeAuth> {
  const row = forgeRow(app.db, id)
  if (row.kind === 'git') throw Object.assign(new Error('a bare git forge authenticates with the container’s SSH key, not a token'), { statusCode: 400 })
  app.db.prepare('UPDATE forges SET token = ?, token_set_at = ?, auth_json = NULL WHERE id = ?').run(token, token ? now() : null, id)
  logEvent(app.db, { level: 'warn', code: token ? 'FORGE_TOKEN_SET' : 'FORGE_TOKEN_CLEARED', message: `${row.name}: token ${token ? 'set' : 'cleared'} by ${by}`, detail: { forge: id } })
  return checkForge(app, id)
}

/** Every forge with a token, re-checked — on boot and then periodically from the scheduler. */
export async function checkAllForges(app: App): Promise<void> {
  const ids = (app.db.prepare("SELECT id FROM forges WHERE kind != 'git' AND token IS NOT NULL").all() as { id: string }[]).map((r) => r.id)
  for (const id of ids) await checkForge(app, id).catch(() => undefined)
}

/** Delivery's gate: refuse before any git push with a sentence a person can act on. */
export function deliveryBlocker(row: ForgeRow, repo?: string): string | undefined {
  if (row.kind === 'git') return undefined
  const auth = authOf(row)
  if (auth.state === 'unconfigured') return `${row.name} has no token, so Lamplighter cannot push there. Set one in Settings → Forges.`
  if (auth.state !== 'failing') return undefined
  // A token that may push here is good enough even if another repo on the forge refuses it.
  const own = repo ? auth.repos?.find((r) => r.repo === repo) : undefined
  if (own?.push && auth.login) return undefined
  return `the ${row.name} token does not work: ${(own && !own.push ? [`${own.repo}: ${own.detail ?? 'cannot push'}`] : auth.problems).join('; ')}. Fix it in Settings → Forges.`
}

export function assertCanDeliver(row: ForgeRow, repo?: string): void {
  const why = deliveryBlocker(row, repo)
  if (why) throw Object.assign(new Error(why), { statusCode: 409 })
}

/**
 * Who a commit is by. The configured identity, when one is set; otherwise (empty, or the old
 * default `lamplighter@localhost`) a GitHub forge's token account, by its noreply address, so
 * the commit is attributed to the account that pushes it — Touchstone's rule.
 */
export function commitIdentity(app: App, forgeId: string): { name: string; email: string } {
  const id = app.config.current.identity
  const name = id.name || 'Lamplighter'
  if (id.email && id.email !== 'lamplighter@localhost') return { name, email: id.email }
  const row = forgeRow(app.db, forgeId)
  const auth = authOf(row)
  if (row.kind === 'github' && auth.login && auth.user_id) return { name, email: `${auth.user_id}+${auth.login}@users.noreply.github.com` }
  return { name, email: id.email || 'lamplighter@localhost' }
}

/**
 * May Lamplighter write to this repository? No means the fixing loop is blocked there — no
 * proposal is drafted, validated or delivered, so nothing is authored only to fail at the push.
 * Rounds (read-only) and `report` delivery go on. Bare git cannot be asked, so it is trusted;
 * a forge token not yet checked counts as no until the check says otherwise.
 */
export function writeAccess(app: App, repo: { forge_id: string; owner: string | null; name: string }): { ok: boolean; why?: string } {
  const row = forgeRow(app.db, repo.forge_id)
  if (row.kind === 'git') return { ok: true }
  const auth = authOf(row)
  const full = `${repo.owner}/${repo.name}`
  if (auth.state === 'unconfigured') return { ok: false, why: `${row.name} has no token, so Lamplighter has no write access to ${full}. Set one in Settings → Forges.` }
  if (auth.state === 'unknown') return { ok: false, why: `the ${row.name} token has not been checked yet.` }
  const own = auth.repos?.find((r) => r.repo === full)
  if (own?.push) return { ok: true }
  if (own) return { ok: false, why: `the ${row.name} token${auth.login ? ` (${auth.login})` : ''} has no write access to ${full}: ${own.detail ?? 'cannot push'}.` }
  if (!auth.login) return { ok: false, why: `the ${row.name} token does not work: ${auth.problems.join('; ')}.` }
  return { ok: false, why: `write access to ${full} has not been checked yet.` }
}
