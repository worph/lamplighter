import type { App } from '../context.js'
import { now } from '../db/index.js'
import { logEvent } from '../events.js'
import { openAlert, resolveFor } from '../activity/index.js'
import { credentialRow, forgeApi, forgeRow, listCredentials } from '../forges/index.js'
import { authOf, credentialFor, fullName, makeDefault, pushRow, type RepoRef } from '../forges/auth.js'
import type { CredentialAuth } from '../forges/types.js'
import { listRepos } from './registry.js'

/**
 * What the fleet's credentials may do: write access per repo (the delivery gate), whose name a
 * commit is under, and the credential check with its alert. Credential resolution itself is
 * `forges/auth.ts`.
 *
 * The check asks, with GETs and one refused empty-blob POST per repo: whose token is it, and may
 * it push to each monitored repository on its forge? A token that is refused, or a repo no
 * credential may push to, opens one alert per forge (`forge.<id>.auth`). No token at all is not a
 * fault: the forge simply reads anonymously, and nothing is alerted.
 */

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
  if (problems.length) {
    openAlert(
      app.db,
      alertCode(forgeId),
      `Lamplighter cannot write everywhere on ${forge.name}`,
      `${problems.join(' ')} Nothing can be delivered there until it is fixed in Settings → Forges; rounds still run.`,
    )
  } else {
    resolveFor(app.db, alertCode(forgeId), 'resolved', 'every credential works and every repo has one that may push')
  }
}

/** Every credential on the forge re-checked, then its alert. */
export async function checkForge(app: App, forgeId: string): Promise<void> {
  // Best effort per credential: checkCredential records forge failures itself; one must not stop the others, and the next AUTH_CHECK_MS tick retries.
  for (const c of listCredentials(app.db, forgeId).filter((x) => x.token)) await checkCredential(app, c.id).catch(() => undefined)
  forgeAlert(app, forgeId)
}

/** Every forge, re-checked — on boot and then periodically from the scheduler. */
export async function checkAllForges(app: App): Promise<void> {
  const ids = (app.db.prepare("SELECT id FROM forges WHERE kind != 'git'").all() as { id: string }[]).map((r) => r.id)
  // Best effort per forge: one must not stop the others, and the next AUTH_CHECK_MS tick retries.
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
