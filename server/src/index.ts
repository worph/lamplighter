import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { registerApi } from './api/index.js'
import { Checks } from './checks/index.js'
import { ConfigStore } from './config/index.js'
import type { App } from './context.js'
import { openDb } from './db/index.js'
import { loadEnv } from './env.js'
import { logEvent } from './events.js'
import { registerHooks } from './hooks/index.js'
import { registerMcp, VERSION } from './mcp/index.js'
import { ensureDefaultGroup, getRepo } from './repos/registry.js'
import { Mirrors } from './repos/mirror.js'
import { sandboxHousekeeping } from './sandbox/index.js'
import { Scheduler } from './scheduler/index.js'
import { SessionRegistry } from './sessions/session.js'
import { SETTING, getOrCreateSecret, getSetting, setSetting } from './settings.js'

async function main() {
  const env = loadEnv()
  mkdirSync(env.dataDir, { recursive: true })
  const db = openDb(join(env.dataDir, 'lamplighter.db'))
  const config = new ConfigStore(join(env.dataDir, 'config.yaml'), env)
  const checks = new Checks(join(env.dataDir, 'checks'), env.seedDir)
  const policyFile = join(env.seedDir, 'policy', 'default.md')
  ensureDefaultGroup(db, existsSync(policyFile) ? readFileSync(policyFile, 'utf8').trim() : '')
  getOrCreateSecret(db, SETTING.adminMcpToken, env.adminMcpToken)
  if (env.seed.inferenceBearer && !getSetting(db, SETTING.inferenceBearer)) setSetting(db, SETTING.inferenceBearer, env.seed.inferenceBearer)

  let scheduler: Scheduler | undefined
  const app: App = {
    db, env, config, checks,
    mirrors: new Mirrors(db, env.dataDir),
    sessions: new SessionRegistry(),
    kick: () => scheduler?.nudge(),
    pollNow: async (key) => {
      await scheduler?.pollOne(getRepo(db, key))
      scheduler?.nudge()
    },
    schedule: () => scheduler!.view(),
  }
  scheduler = new Scheduler(app)

  const f = Fastify({ logger: { level: env.logLevel }, disableRequestLogging: true, bodyLimit: 5 * 1024 * 1024, trustProxy: true })
  registerHooks(f, app, () => scheduler?.nudge())
  registerApi(f, app)
  registerMcp(f, app)
  if (existsSync(env.publicDir)) {
    await f.register(fastifyStatic, { root: env.publicDir, wildcard: false })
    f.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/mcp') || req.url.startsWith('/hooks/')) return reply.code(404).send({ error: 'not found' })
      return reply.sendFile('index.html')
    })
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      scheduler?.stop()
      void f.close().then(() => process.exit(0))
    })
  }

  await f.listen({ port: env.port, host: env.host })
  logEvent(db, { code: 'STARTED', message: `Lamplighter ${VERSION} started; inference ${config.current.inference.driver} at ${config.current.inference.url}` })
  if (checks.upgraded.length) logEvent(db, { code: 'CHECKS_UPGRADED', message: `check files updated to this release's seeds (they were unedited): ${checks.upgraded.join(', ')}` })
  scheduler.start()

  const housekeeping = async (what: 'reap' | 'trim') => {
    const note = await sandboxHousekeeping(app, what)
    if (note) logEvent(db, { level: note.includes('failed') ? 'warn' : 'info', code: 'SANDBOX', message: note })
  }
  void housekeeping('reap')
  setInterval(() => void housekeeping('trim'), SANDBOX_TRIM_MS).unref()
}

const SANDBOX_TRIM_MS = 24 * 3600 * 1000

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
