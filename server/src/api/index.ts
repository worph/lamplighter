import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { checkSettingsSchema, identitySchema, inferenceSchema, sandboxSchema, scheduleSchema } from '../config/index.js'
import type { App } from '../context.js'
import { now } from '../db/index.js'
import { listEvents, logEvent } from '../events.js'
import { lastDecision, listFindings } from '../findings/index.js'
import { personDecides, policyChanged, watchAdmission } from '../admission/index.js'
import { credentialRow, forgeApi, forgeRow, listCredentials, listForges } from '../forges/index.js'
import {
  addCredential, asAnyCredential, assertPinnable, checkCredential, checkForge, credentialFor, credentialView, forgeAlert, forgeView,
  normalizeToken, patchCredential, removeCredential, setCredentialToken, writeAccess,
} from '../forges/auth.js'
import { driverFor } from '../inference/index.js'
import { getItem, listItems, resolveItem } from '../activity/index.js'
import { addRepo, getRepo, listGroups, listRepos, parseSettings, getGroup } from '../repos/registry.js'
import { probeSandbox } from '../sandbox/index.js'
import { enqueueRound } from '../scheduler/index.js'
import { maybePropose, settingsFor } from '../sessions/engine.js'
import { deliver, getProposal, mergeBranch, rejectProposal, revertPush } from '../delivery/index.js'
import { SETTING, getSetting, masked, setSetting } from '../settings.js'
import { randomBytes } from 'node:crypto'
import { confirm, messages, newThread, runTurn } from '../chat/index.js'
import { VERSION } from '../mcp/index.js'

type Lamp = 'lit' | 'dim' | 'out' | 'unlit' | 'off'

/**
 * One light per (repo, check): never run, last round broken, work left (raised and not judged yet,
 * admitted, or in a proposal), or clean. What admission put aside does not dim it (§6.4); `later`
 * counts it, so green cannot be reached by deferring quietly.
 */
export function lamps(app: App, repoKey: string): Record<string, { lamp: Lamp; open: number; later: number; last?: string; status?: string }> {
  const repo = getRepo(app.db, repoKey)
  const out: Record<string, { lamp: Lamp; open: number; later: number; last?: string; status?: string }> = {}
  for (const def of app.checks.list()) {
    const last = app.db
      .prepare("SELECT status, started_at FROM rounds WHERE repo_key = ? AND check_kind = ? AND kind = 'round' ORDER BY started_at DESC LIMIT 1")
      .get(repoKey, def.kind) as { status: string; started_at: string } | undefined
    const count = (states: string) =>
      (app.db.prepare(`SELECT COUNT(*) AS n FROM findings WHERE repo_key = ? AND check_kind = ? AND state IN (${states})`).get(repoKey, def.kind) as { n: number }).n
    const open = count("'open','admitted','proposed'")
    const later = count("'deferred','declined'")
    // A running round has no verdict yet: the light is the last finished round's, so a check's first
    // round shows unlit, not lit with nothing found.
    const done = last?.status === 'running'
      ? (app.db
          .prepare("SELECT status FROM rounds WHERE repo_key = ? AND check_kind = ? AND kind = 'round' AND status != 'running' ORDER BY started_at DESC LIMIT 1")
          .get(repoKey, def.kind) as { status: string } | undefined)
      : last
    const enabled = settingsFor(app, repo, def).enabled
    const lamp: Lamp = !enabled ? 'off' : !done ? 'unlit' : done.status === 'blocked' || done.status === 'failed' ? 'out' : open ? 'dim' : 'lit'
    out[def.kind] = { lamp, open, later, last: last?.started_at, status: last?.status }
  }
  return out
}

const forgeInput = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes'),
  kind: z.enum(['github', 'gitea', 'git']),
  name: z.string().min(1),
  base_url: z.string().optional().nullable(),
  webhook_secret: z.string().optional().nullable(),
})

const credentialInput = z.object({
  label: z.string().min(1).max(60),
  username: z.string().optional().nullable(),
  commit_name: z.string().optional().nullable(),
  commit_email: z.string().email().or(z.literal('')).optional().nullable(),
  is_default: z.boolean().optional(),
})

/** Which credential the repo uses and why — never the token. */
function credentialOf(app: App, r: Parameters<typeof credentialFor>[1]) {
  const { cred, via } = credentialFor(app.db, r)
  return cred ? { id: cred.id, label: cred.label, via, login: credentialView(cred).auth.login } : null
}

export function registerApi(f: FastifyInstance, app: App): void {
  f.setErrorHandler((error, _req, reply) => {
    const err = error as Error
    const status = (err as { statusCode?: number }).statusCode
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') })
    reply.code(status && status >= 400 ? status : 400).send({ error: err.message })
  })

  f.get('/healthz', async () => ({ ok: true, version: VERSION }))

  // ── overview ──────────────────────────────────────────────────────────────────────────
  f.get('/api/v1/overview', async () => {
    const counts = (q: string) => (app.db.prepare(q).get() as { n: number }).n
    return {
      version: VERSION,
      repos: counts('SELECT COUNT(*) AS n FROM repos'),
      open_findings: counts("SELECT COUNT(*) AS n FROM findings WHERE state IN ('open','admitted','proposed')"),
      not_now: counts("SELECT COUNT(*) AS n FROM findings WHERE state IN ('deferred','declined')"),
      inbox: counts("SELECT COUNT(*) AS n FROM activity WHERE state = 'open'"),
      schedule: app.schedule(),
      inference: { driver: app.config.current.inference.driver, url: app.config.current.inference.url },
      check_errors: app.checks.errors,
    }
  })

  // ── repos ─────────────────────────────────────────────────────────────────────────────
  f.get('/api/v1/repos', async () =>
    listRepos(app.db).map((r) => ({
      key: r.key, forge_id: r.forge_id, group_id: r.group_id, owner: r.owner, name: r.name, line: r.line, visibility: r.visibility,
      last_head: r.last_head, last_fetch_at: r.last_fetch_at, fetch_error: r.fetch_error, lamps: lamps(app, r.key), write: writeAccess(app, r),
      credential_id: r.credential_id, credential: credentialOf(app, r),
    })),
  )

  f.post('/api/v1/repos', async (req) => {
    const body = z
      .object({ forge_id: z.string(), owner: z.string().optional(), name: z.string().min(1), remote_url: z.string().optional(), line: z.string().optional(), group_id: z.string().optional(), visibility: z.enum(['public', 'private']).optional() })
      .parse(req.body)
    const r = await addRepo(app.db, { ...body, owner: body.owner || undefined, remote_url: body.remote_url || undefined, line: body.line || undefined })
    logEvent(app.db, { code: 'REPO_ADDED', repo: r.key, message: 'added from the UI' })
    void app.pollNow(r.key)
    void checkForge(app, r.forge_id).catch(() => undefined) // a new repo is a new "may it push here?" for every credential
    return r
  })

  f.get('/api/v1/repos/:key', async (req) => {
    const key = (req.params as { key: string }).key
    const r = getRepo(app.db, key)
    const group = getGroup(app.db, r.group_id)
    return {
      ...r,
      settings: parseSettings(r.settings_json),
      group,
      lamps: lamps(app, key),
      write: writeAccess(app, r),
      credential: credentialOf(app, r),
      credentials: listCredentialsView(app, r.forge_id),
      checks: app.checks.list().map((def) => ({ kind: def.kind, title: def.title, scopes: def.scopes, agent: def.agent, settings: settingsFor(app, r, def) })),
      findings: listFindings(app.db, { repo: key, limit: 500 }).map((x) => ({ ...x, decision: lastDecision(app.db, x.id) })),
      rounds: app.db.prepare('SELECT id, check_kind, kind, scope, status, summary, error, trigger, base_sha, head_sha, proposal_id, started_at, ended_at FROM rounds WHERE repo_key = ? ORDER BY started_at DESC LIMIT 60').all(key),
      proposals: app.db.prepare('SELECT id, check_kind, state, delivery, branch, base_sha, head_sha, summary, error, submitted_ref, created_at, updated_at FROM proposals WHERE repo_key = ? ORDER BY created_at DESC LIMIT 30').all(key),
      events: listEvents(app.db, { repo: key, limit: 50 }),
    }
  })

  f.patch('/api/v1/repos/:key', async (req) => {
    const key = (req.params as { key: string }).key
    getRepo(app.db, key)
    const r = getRepo(app.db, key)
    const body = z
      .object({ policy: z.string().optional(), group_id: z.string().optional(), visibility: z.enum(['public', 'private']).optional(), line: z.string().optional(), credential_id: z.string().nullable().optional() })
      .parse(req.body)
    if (body.group_id) getGroup(app.db, body.group_id)
    if (body.credential_id !== undefined) assertPinnable(app.db, body.credential_id, r.forge_id)
    for (const [col, v] of Object.entries(body)) if (v !== undefined) app.db.prepare(`UPDATE repos SET ${col} = ? WHERE key = ?`).run(v, key)
    if (body.policy !== undefined && body.policy !== r.policy) policyChanged(app, { repo: key })
    if (body.credential_id !== undefined || body.group_id) {
      logEvent(app.db, { level: 'warn', code: 'REPO_CREDENTIAL', repo: key, message: `credential: ${credentialOf(app, getRepo(app.db, key))?.label ?? 'none'} (${body.credential_id === undefined ? 'group changed' : body.credential_id ? 'pinned' : 'unpinned'} by operator)` })
      forgeAlert(app, r.forge_id)
    }
    return getRepo(app.db, key)
  })

  f.delete('/api/v1/repos/:key', async (req) => {
    const key = (req.params as { key: string }).key
    getRepo(app.db, key)
    app.db.prepare('DELETE FROM repos WHERE key = ?').run(key)
    logEvent(app.db, { code: 'REPO_REMOVED', message: `${key} removed` })
    return { ok: true }
  })

  f.post('/api/v1/repos/:key/rounds', async (req) => {
    const key = (req.params as { key: string }).key
    const body = z.object({ check: z.string(), scope: z.enum(['full', 'diff']).optional() }).parse(req.body)
    getRepo(app.db, key)
    const checks = body.check === 'all' ? app.checks.list().map((c) => c.kind) : [body.check]
    return checks.map((check) => enqueueRound(app, { repo: key, check, scope: body.scope ?? 'full', foreground: true, tier: 0, trigger: 'request' }))
  })

  f.post('/api/v1/repos/:key/fix', async (req) => {
    const key = (req.params as { key: string }).key
    const { check } = z.object({ check: z.string() }).parse(req.body)
    const def = app.checks.get(check)
    if (!def) throw new Error(`no check ${check}`)
    return { result: maybePropose(app, getRepo(app.db, key), def, true) }
  })

  f.post('/api/v1/repos/:key/fetch', async (req) => {
    const key = (req.params as { key: string }).key
    await app.pollNow(key)
    return getRepo(app.db, key)
  })

  f.put('/api/v1/repos/:key/checks/:check', async (req) => {
    const { key, check } = req.params as { key: string; check: string }
    const r = getRepo(app.db, key)
    const settings = checkSettingsSchema.nullable().parse(req.body)
    const s = parseSettings(r.settings_json) as { checks?: Record<string, unknown> }
    s.checks = { ...(s.checks ?? {}) }
    if (settings === null || Object.keys(settings).length === 0) delete s.checks[check]
    else s.checks[check] = settings
    watchAdmission(app, check, [r], () => app.db.prepare('UPDATE repos SET settings_json = ? WHERE key = ?').run(JSON.stringify(s), key))
    return { ok: true }
  })

  // ── findings, rounds, proposals ───────────────────────────────────────────────────────
  f.post('/api/v1/findings/:id/dismiss', async (req) => {
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body)
    return personDecides(app, (req.params as { id: string }).id, 'dismiss', reason, 'operator')
  })
  f.post('/api/v1/findings/:id/take', async (req) => {
    const { reason } = z.object({ reason: z.string().max(800).default('') }).parse(req.body ?? {})
    return personDecides(app, (req.params as { id: string }).id, 'take', reason, 'operator')
  })
  f.post('/api/v1/findings/:id/reopen', async (req) => personDecides(app, (req.params as { id: string }).id, 'reopen', '', 'operator'))

  f.get('/api/v1/rounds/:id', async (req) => {
    const r = app.db.prepare('SELECT * FROM rounds WHERE id = ?').get((req.params as { id: string }).id)
    if (!r) throw Object.assign(new Error('no such round'), { statusCode: 404 })
    return r
  })

  f.get('/api/v1/proposals/:id', async (req) => {
    const p = getProposal(app.db, (req.params as { id: string }).id)
    if (!p) throw Object.assign(new Error('no such proposal'), { statusCode: 404 })
    const ids = JSON.parse(p.finding_ids) as string[]
    const findings = ids.map((id) => app.db.prepare('SELECT id, title, anchor, category, severity, state FROM findings WHERE id = ?').get(id)).filter(Boolean)
    return { ...p, validation: p.validation ? JSON.parse(p.validation) : null, findings, write: writeAccess(app, getRepo(app.db, p.repo_key)) }
  })
  f.post('/api/v1/proposals/:id/approve', async (req) => deliver(app, (req.params as { id: string }).id, 'operator'))
  f.post('/api/v1/proposals/:id/reject', async (req) => {
    const { reason } = z.object({ reason: z.string().default('') }).parse(req.body ?? {})
    return rejectProposal(app, (req.params as { id: string }).id, reason, 'operator')
  })
  f.post('/api/v1/proposals/:id/merge', async (req) => mergeBranch(app, (req.params as { id: string }).id, 'operator'))
  f.post('/api/v1/proposals/:id/revert', async (req) => revertPush(app, (req.params as { id: string }).id, 'operator'))

  // ── activity ──────────────────────────────────────────────────────────────────────────
  f.get('/api/v1/activity', async (req) => {
    const q = req.query as { state?: 'open' | 'resolved'; repo?: string }
    return { items: listItems(app.db, { state: q.state, repo: q.repo, limit: 200 }), events: listEvents(app.db, { limit: 150 }) }
  })
  f.post('/api/v1/activity/:id/resolve', async (req) => {
    const id = (req.params as { id: string }).id
    const { reason } = z.object({ reason: z.string().optional() }).parse(req.body ?? {})
    if (!getItem(app.db, id)) throw Object.assign(new Error('no such item'), { statusCode: 404 })
    resolveItem(app.db, id, 'acknowledged', reason)
    return { ok: true }
  })

  // ── settings ──────────────────────────────────────────────────────────────────────────
  f.get('/api/v1/settings', async () => {
    const cfg = app.config.current
    return {
      config: cfg,
      inference_bearer: masked(getSetting(app.db, SETTING.inferenceBearer)),
      admin_mcp_token: masked(getSetting(app.db, SETTING.adminMcpToken)),
      forges: listForges(app.db).map((x) => ({
        ...forgeView(app.db, x),
        repos: listRepos(app.db).filter((r) => r.forge_id === x.id).map((r) => ({ repo: r.owner ? `${r.owner}/${r.name}` : r.name, key: r.key, credential: credentialOf(app, r), write: writeAccess(app, r) })),
      })),
      groups: listGroups(app.db),
      checks: app.checks.list().map((c) => ({ kind: c.kind, title: c.title, revision: c.revision, scopes: c.scopes, agent: c.agent, sensitive: c.sensitive, defaults: c.defaults, settings: { ...c.defaults, ...(cfg.checks[c.kind] ?? {}) } })),
      check_errors: app.checks.errors,
      schedule: app.schedule(),
    }
  })

  f.put('/api/v1/settings/inference', async (req) => {
    const patch = inferenceSchema.partial().parse(req.body)
    return app.config.update(['inference'], patch).inference
  })
  f.put('/api/v1/settings/inference/bearer', async (req) => {
    const { value } = z.object({ value: z.string().nullable() }).parse(req.body)
    setSetting(app.db, SETTING.inferenceBearer, value || null)
    return { inference_bearer: masked(value) }
  })
  f.post('/api/v1/settings/inference/test', async () => driverFor(app.config.current, app.db).probe())
  f.put('/api/v1/settings/schedule', async (req) => app.config.update(['schedule'], scheduleSchema.partial().parse(req.body)).schedule)
  f.put('/api/v1/settings/sandbox', async (req) => app.config.update(['sandbox'], sandboxSchema.partial().parse(req.body)).sandbox)
  f.post('/api/v1/settings/sandbox/test', async () => probeSandbox(app))
  f.put('/api/v1/settings/general', async (req) => {
    const body = z.object({ public_url: z.string().url().optional(), identity: identitySchema.partial().optional() }).parse(req.body)
    if (body.identity) app.config.update(['identity'], body.identity)
    if (body.public_url) app.config.setRoot('public_url', body.public_url.replace(/\/$/, ''))
    return app.config.current
  })
  f.put('/api/v1/settings/checks/:check', async (req) => {
    const check = (req.params as { check: string }).check
    if (!app.checks.get(check)) throw new Error(`no check ${check}`)
    const settings = checkSettingsSchema.parse(req.body)
    return watchAdmission(app, check, listRepos(app.db), () => app.config.update(['checks', check], settings).checks[check])
  })
  f.post('/api/v1/settings/checks/reload', async () => {
    app.checks.reload()
    return { checks: app.checks.list().map((c) => c.kind), errors: app.checks.errors }
  })
  f.get('/api/v1/settings/mcp-token', async () => ({ token: getSetting(app.db, SETTING.adminMcpToken) }))
  f.post('/api/v1/settings/mcp-token/rotate', async () => {
    const token = randomBytes(24).toString('base64url')
    setSetting(app.db, SETTING.adminMcpToken, token)
    return { token }
  })

  // ── forges and groups ─────────────────────────────────────────────────────────────────
  f.post('/api/v1/forges', async (req) => {
    const b = forgeInput.parse(req.body)
    if (b.kind === 'gitea' && !b.base_url) throw new Error('a Gitea forge needs its base URL')
    app.db
      .prepare('INSERT INTO forges (id, kind, name, base_url, webhook_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(b.id, b.kind, b.name, b.base_url || null, b.webhook_secret || null, now())
    return { id: b.id }
  })
  f.patch('/api/v1/forges/:id', async (req) => {
    const id = (req.params as { id: string }).id
    forgeRow(app.db, id)
    const b = forgeInput.partial().omit({ id: true, kind: true }).parse(req.body)
    for (const [col, v] of Object.entries(b)) if (v !== undefined) app.db.prepare(`UPDATE forges SET ${col} = ? WHERE id = ?`).run(v || null, id)
    return { ok: true }
  })
  f.delete('/api/v1/forges/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const used = app.db.prepare('SELECT COUNT(*) AS n FROM repos WHERE forge_id = ?').get(id) as { n: number }
    if (used.n) throw new Error(`${used.n} repo(s) still use this forge`)
    app.db.prepare('DELETE FROM forges WHERE id = ?').run(id)
    return { ok: true }
  })
  f.post('/api/v1/forges/:id/probe', async (req) => {
    const id = (req.params as { id: string }).id
    return forgeApi(forgeRow(app.db, id), listCredentials(app.db, id).find((c) => c.token) ?? null).probe()
  })
  f.post('/api/v1/forges/:id/auth/check', async (req) => {
    const id = (req.params as { id: string }).id
    await checkForge(app, id)
    return forgeView(app.db, forgeRow(app.db, id))
  })
  // Credentials, Touchstone's way: tokens are write-only (nothing returns them), checked in the
  // same response, and set — like every pin — only here: no chat or admin-MCP tool can choose
  // whose name Lamplighter pushes under.
  f.post('/api/v1/forges/:id/credentials', async (req) => {
    const id = (req.params as { id: string }).id
    return credentialView(addCredential(app, id, credentialInput.parse(req.body)))
  })
  f.patch('/api/v1/credentials/:id', async (req) => {
    const id = (req.params as { id: string }).id
    const cred = patchCredential(app, id, credentialInput.partial().parse(req.body))
    forgeAlert(app, cred.forge_id)
    return credentialView(cred)
  })
  f.delete('/api/v1/credentials/:id', async (req) => {
    removeCredential(app, (req.params as { id: string }).id, 'operator')
    return { ok: true }
  })
  f.post('/api/v1/credentials/:id/check', async (req) => {
    const id = (req.params as { id: string }).id
    const auth = await checkCredential(app, id)
    forgeAlert(app, credentialRow(app.db, id).forge_id)
    return auth
  })
  f.put('/api/v1/credentials/:id/token', async (req) => {
    const id = (req.params as { id: string }).id
    return setCredentialToken(app, id, normalizeToken((req.body as { token?: unknown } | undefined)?.token), 'operator')
  })
  f.delete('/api/v1/credentials/:id/token', async (req) => setCredentialToken(app, (req.params as { id: string }).id, null, 'operator'))
  f.get('/api/v1/forges/:id/discover', async (req) => {
    const { owner } = z.object({ owner: z.string().min(1) }).parse(req.query)
    const id = (req.params as { id: string }).id
    const known = new Set(listRepos(app.db).map((r) => r.key))
    // The owner's private repos are visible to the credential for that owner: ask as any that can.
    const list = await asAnyCredential(app.db, id, (api) => api.listRepos(owner))
    return list.map((r) => ({ ...r, enrolled: known.has(`${id}~${r.owner}/${r.name}`) }))
  })

  f.post('/api/v1/groups', async (req) => {
    const b = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/), name: z.string().min(1), policy: z.string().default('') }).parse(req.body)
    app.db.prepare('INSERT INTO groups (id, name, policy) VALUES (?, ?, ?)').run(b.id, b.name, b.policy)
    return getGroup(app.db, b.id)
  })
  f.patch('/api/v1/groups/:id', async (req) => {
    const id = (req.params as { id: string }).id
    getGroup(app.db, id)
    const b = z.object({ name: z.string().optional(), policy: z.string().optional(), credential_id: z.string().nullable().optional() }).parse(req.body)
    if (b.name !== undefined) app.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(b.name, id)
    if (b.policy !== undefined && b.policy !== getGroup(app.db, id).policy) {
      app.db.prepare('UPDATE groups SET policy = ? WHERE id = ?').run(b.policy, id)
      policyChanged(app, { group: id })
    }
    if (b.credential_id !== undefined) {
      assertPinnable(app.db, b.credential_id)
      app.db.prepare('UPDATE groups SET credential_id = ? WHERE id = ?').run(b.credential_id, id)
      logEvent(app.db, { level: 'warn', code: 'GROUP_CREDENTIAL', message: `group ${id}: credential ${b.credential_id ?? 'unpinned'} by operator` })
      for (const forge of listForges(app.db)) forgeAlert(app, forge.id)
    }
    return getGroup(app.db, id)
  })

  // ── schedule ──────────────────────────────────────────────────────────────────────────
  f.get('/api/v1/schedule', async () => app.schedule())
  f.delete('/api/v1/queue/:id', async (req) => {
    const r = app.db.prepare("DELETE FROM queue WHERE id = ? AND state = 'queued'").run((req.params as { id: string }).id)
    if (!r.changes) throw new Error('not a queued job')
    return { ok: true }
  })

  // ── chat ──────────────────────────────────────────────────────────────────────────────
  f.get('/api/v1/chat', async () => ({ messages: messages(app) }))
  f.post('/api/v1/chat', async (req) => {
    const { message } = z.object({ message: z.string().min(1).max(8000) }).parse(req.body)
    return { messages: await runTurn(app, message) }
  })
  f.post('/api/v1/chat/confirm', async (req) => {
    const b = z.object({ id: z.number().int(), typed: z.string() }).parse(req.body)
    return { messages: await confirm(app, b.id, b.typed) }
  })
  f.delete('/api/v1/chat', async () => ({ thread: newThread(app) }))
}

/** The pin choices on the Repo page. */
function listCredentialsView(app: App, forgeId: string) {
  return listCredentials(app.db, forgeId).map(credentialView).map((c) => ({ id: c.id, label: c.label, is_default: c.is_default, login: c.auth.login }))
}
