import { createHmac, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { App } from '../context.js'
import { logEvent } from '../events.js'
import { listForges } from '../forges/index.js'
import type { ForgeRow } from '../forges/types.js'

/**
 * Push webhooks only make a repo due for its next fetch; the poller does the rest, so a webhook
 * and a poll can never disagree about what is new, and the loop guard applies to both.
 */

function verify(secret: string, body: Buffer, signature: string | undefined, prefix: string): boolean {
  if (!signature) return false
  const expected = prefix + createHmac('sha256', secret).update(body).digest('hex')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}

function markDue(app: App, forge: ForgeRow, owner: string, name: string, ref: string): boolean {
  const repo = app.db.prepare('SELECT key, line FROM repos WHERE forge_id = ? AND owner = ? AND name = ?').get(forge.id, owner, name) as
    | { key: string; line: string }
    | undefined
  if (!repo || ref !== `refs/heads/${repo.line}`) return false
  app.db.prepare('UPDATE repos SET last_fetch_at = NULL WHERE key = ?').run(repo.key)
  logEvent(app.db, { code: 'WEBHOOK', repo: repo.key, message: `push webhook for ${ref}` })
  app.kick()
  return true
}

export function registerHooks(f: FastifyInstance, app: App, onPoll: () => void): void {
  f.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (req, body, done) => {
    ;(req as unknown as { rawBody: Buffer }).rawBody = body as Buffer
    try {
      done(null, (body as Buffer).length ? JSON.parse((body as Buffer).toString('utf8')) : {})
    } catch (err) {
      done(err as Error, undefined)
    }
  })

  for (const kind of ['github', 'gitea'] as const) {
    f.post(`/hooks/${kind}/:forge`, async (req, reply) => {
      const forge = listForges(app.db).find((x) => x.id === (req.params as { forge: string }).forge && x.kind === kind)
      if (!forge?.webhook_secret) return reply.code(404).send({ error: 'no such forge, or it has no webhook secret' })
      const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.alloc(0)
      const ok =
        kind === 'github'
          ? verify(forge.webhook_secret, raw, req.headers['x-hub-signature-256'] as string | undefined, 'sha256=')
          : verify(forge.webhook_secret, raw, req.headers['x-gitea-signature'] as string | undefined, '')
      if (!ok) return reply.code(401).send({ error: 'bad signature' })
      const event = (req.headers['x-github-event'] ?? req.headers['x-gitea-event']) as string | undefined
      if (event !== 'push') return { ignored: event ?? 'unknown event' }
      const body = req.body as { ref?: string; repository?: { name?: string; owner?: { login?: string; username?: string } } }
      const owner = body.repository?.owner?.login ?? body.repository?.owner?.username ?? ''
      const matched = markDue(app, forge, owner, body.repository?.name ?? '', body.ref ?? '')
      if (matched) onPoll()
      return { matched }
    })
  }
}
