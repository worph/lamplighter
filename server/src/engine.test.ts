import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { Checks } from './checks/index.js'
import { configSchema } from './config/index.js'
import type { App } from './context.js'
import { openDb } from './db/index.js'
import { afterReady, getProposal } from './delivery/index.js'
import { Mirrors } from './repos/mirror.js'
import type { RepoRow } from './repos/registry.js'
import { judge, type CommandOutcome } from './sandbox/validate.js'
import { validate } from './sessions/engine.js'
import { SessionRegistry } from './sessions/session.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'll-e-'))
const green: CommandOutcome = { ok: true, exit: 0, ms: 10, timedOut: false, tail: '' }
const red: CommandOutcome = { ok: false, exit: 1, ms: 10, timedOut: false, tail: 'not ok 1' }

describe('mechanical validation (architecture §7.3)', () => {
  it('fails a proposal on a test that passed on base, after one re-run', async () => {
    let reruns = 0
    const v = await judge(['npm test'], [green], [red], async () => (reruns++, red))
    expect(reruns).toBe(1)
    expect(v.ok).toBe(false)
    expect(v.results[0]).toMatchObject({ reran: true, regression: true })
  })

  it('lets a flaky test through when the re-run passes', async () => {
    const v = await judge(['npm test'], [green], [red], async () => green)
    expect(v.ok).toBe(true)
    expect(v.results[0]).toMatchObject({ reran: true, regression: false })
  })

  it('does not hold a red base against the fix', async () => {
    let reruns = 0
    const v = await judge(['npm test', 'npm run lint'], [red, green], [red, green], async () => (reruns++, red))
    expect(reruns).toBe(0)
    expect(v.ok).toBe(true)
  })
})

describe('auto-submit', () => {
  it('is never the approval when no test ran on the proposal', async () => {
    const data = tmp()
    const db = openDb(join(data, 'db.sqlite'))
    db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('f','git','f','now')").run()
    db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
    db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, created_at) VALUES ('f~r','f','default','','r','x','main','now')").run()
    const validation = JSON.stringify({ ok: true, mechanical: { ran: false, ok: true, reason: 'the sandbox is off', results: [] } })
    db.prepare("INSERT INTO proposals (id, repo_key, check_kind, branch, base_sha, head_sha, state, delivery, finding_ids, validation, created_at, updated_at) VALUES ('p1', 'f~r', 'docs', 'lamplighter/docs/x', 'b', 'h', 'ready', 'push', '[]', ?, 'now', 'now')").run(validation)
    const seed = fileURLToPath(new URL('../../seed', import.meta.url))
    const app = { db, config: { current: configSchema.parse({}) }, checks: new Checks(join(data, 'checks'), seed) } as unknown as App
    expect(app.checks.get('docs')!.defaults.auto_submit).toBe(true)
    await afterReady(app, 'p1')
    expect(getProposal(db, 'p1')!.state).toBe('ready')
    expect((db.prepare("SELECT body FROM activity WHERE ref_id = 'p1'").get() as { body: string }).body).toMatch(/not auto-submitted: no tests ran/)
  })
})

/**
 * The engine end to end against a real Docker (see sandbox.test.ts): a proposal that breaks a test
 * is failed by the tests alone; one that does not goes on to the confirming round and is ready.
 */
const DOCKER = process.env.LAMPLIGHTER_TEST_DOCKER
describe.skipIf(!DOCKER)('validation in sandboxes', () => {
  let server: Server | undefined
  afterAll(() => server?.close())

  it('judges proposals by the base\'s tests, then by a review session', { timeout: 1_200_000 }, async () => {
    // A model that ends every session at once: enough for the confirming round to make its call.
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'f', type: 'function', function: { name: 'finish', arguments: '{"summary":"The change is correct."}' } }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    const origin = tmp()
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: origin, encoding: 'utf8' }).trim()
    g('init', '-q', '-b', 'main')
    writeFileSync(join(origin, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node --test' } }))
    writeFileSync(join(origin, '.nvmrc'), '22\n')
    writeFileSync(join(origin, 'sum.js'), 'module.exports = (a, b) => a + b\n')
    writeFileSync(join(origin, 'sum.test.js'), "const t = require('node:test'); const a = require('node:assert'); const sum = require('./sum'); t('sums', () => a.strictEqual(sum(1, 2), 3))\n")
    g('add', '-A')
    g('commit', '-qm', 'base')
    const base = g('rev-parse', 'HEAD')
    writeFileSync(join(origin, 'sum.js'), 'module.exports = (a, b) => a - b\n')
    g('commit', '-qam', 'breaks the sum')
    const broken = g('rev-parse', 'HEAD')
    g('reset', '-q', '--hard', base)
    writeFileSync(join(origin, 'README.md'), '# fx\n')
    g('add', '-A')
    g('commit', '-qm', 'docs only')
    const harmless = g('rev-parse', 'HEAD')
    g('branch', '-q', 'keep-broken', broken)

    const data = tmp()
    const db = openDb(join(data, 'db.sqlite'))
    db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('f','git','f','now')").run()
    db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
    db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, created_at) VALUES ('f~r','f','default','','r',?,'main','now')").run(origin)
    const repo = db.prepare("SELECT * FROM repos WHERE key = 'f~r'").get() as RepoRow
    const config = configSchema.parse({
      public_url: 'http://unused',
      inference: { driver: 'openai', url: `http://127.0.0.1:${port}/v1`, model: 'm', timeout_s: 600 },
      sandbox: { enabled: true, docker_url: DOCKER },
    })
    const seed = fileURLToPath(new URL('../../seed', import.meta.url))
    const app = { db, config: { current: config }, checks: new Checks(join(data, 'checks'), seed), mirrors: new Mirrors(db, data), sessions: new SessionRegistry() } as unknown as App
    await app.mirrors.fetch(repo)

    const proposal = (id: string, head: string) => {
      db.prepare("INSERT INTO findings (id, repo_key, check_kind, fingerprint, category, anchor, title, body, severity, state, input_hash, first_round, last_round, proposal_id, created_at, updated_at) VALUES (?, 'f~r', 'docs', ?, 'stale', 'README.md', 't', '', 'minor', 'proposed', 'h', 'r0', 'r0', ?, 'now', 'now')").run(`f_${id}`, `fp_${id}`, id)
      db.prepare("INSERT INTO proposals (id, repo_key, check_kind, branch, base_sha, head_sha, state, delivery, finding_ids, created_at, updated_at) VALUES (?, 'f~r', 'docs', ?, ?, ?, 'validating', 'branch', ?, 'now', 'now')").run(id, `lamplighter/docs/${id}`, base, head, JSON.stringify([`f_${id}`]))
      return getProposal(db, id)!
    }

    await validate(app, proposal('p_broken', broken), 'test')
    const pb = getProposal(db, 'p_broken')!
    expect(pb.state).toBe('failed')
    const vb = JSON.parse(pb.validation!)
    expect(vb.mechanical.results[0]).toMatchObject({ command: 'npm test', regression: true, reran: true })
    expect(vb.mechanical.results[0].base.ok).toBe(true)

    await validate(app, proposal('p_ok', harmless), 'test')
    const po = getProposal(db, 'p_ok')!
    const vo = JSON.parse(po.validation!)
    expect(vo.mechanical).toMatchObject({ ran: true, ok: true })
    expect(vo.mechanical.results[0].base.cached).toBe(true) // the base was judged once
    expect(vo.ok).toBe(true)
    // docs auto-submits by default, and tests ran on it, so passing validation was the approval.
    expect(po.state).toBe('submitted')
    expect(g('branch', '--list', 'lamplighter/docs/p_ok')).toContain('lamplighter/docs/p_ok')
  })

  it('proves a CVE fix by re-scanning the proposal', { timeout: 1_200_000 }, async () => {
    const origin = tmp()
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: origin, encoding: 'utf8' }).trim()
    const npm = (...args: string[]) => execFileSync('npm', [...args, '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: origin, encoding: 'utf8' })
    g('init', '-q', '-b', 'main')
    writeFileSync(join(origin, 'package.json'), JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node --test' }, dependencies: { lodash: '4.17.15' } }, null, 2))
    writeFileSync(join(origin, '.nvmrc'), '22\n')
    writeFileSync(join(origin, 'pick.test.js'), "const t = require('node:test'); const a = require('node:assert'); const _ = require('lodash'); t('picks', () => a.deepStrictEqual(_.pick({ a: 1, b: 2 }, ['a']), { a: 1 }))\n")
    npm('install', '--package-lock-only')
    g('add', '-A')
    g('commit', '-qm', 'base')
    const base = g('rev-parse', 'HEAD')
    writeFileSync(join(origin, 'README.md'), '# fx\n')
    g('add', '-A')
    g('commit', '-qm', 'claims a fix, changes nothing')
    const unfixed = g('rev-parse', 'HEAD')
    g('reset', '-q', '--hard', base)
    npm('install', '--package-lock-only', 'lodash@4.18.1')
    g('commit', '-qam', 'lodash 4.18.1')
    const fixed = g('rev-parse', 'HEAD')
    g('branch', '-q', 'keep-unfixed', unfixed)

    const data = tmp()
    const db = openDb(join(data, 'db.sqlite'))
    db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('f','git','f','now')").run()
    db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
    db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, created_at) VALUES ('f~r','f','default','','r',?,'main','now')").run(origin)
    const repo = db.prepare("SELECT * FROM repos WHERE key = 'f~r'").get() as RepoRow
    const port = (server!.address() as { port: number }).port
    const config = configSchema.parse({ public_url: 'http://unused', inference: { driver: 'openai', url: `http://127.0.0.1:${port}/v1`, model: 'm', timeout_s: 600 }, sandbox: { enabled: true, docker_url: DOCKER } })
    const seed = fileURLToPath(new URL('../../seed', import.meta.url))
    const app = { db, config: { current: config }, checks: new Checks(join(data, 'checks'), seed), mirrors: new Mirrors(db, data), sessions: new SessionRegistry() } as unknown as App
    await app.mirrors.fetch(repo)
    const proposal = (id: string, head: string) => {
      db.prepare("INSERT INTO findings (id, repo_key, check_kind, fingerprint, category, anchor, title, body, severity, state, input_hash, first_round, last_round, proposal_id, created_at, updated_at) VALUES (?, 'f~r', 'cve', ?, 'vulnerable-dependency', 'npm:lodash@4.17.15', 'lodash', '', 'critical', 'proposed', 'h', 'r0', 'r0', ?, 'now', 'now')").run(`f_${id}`, `fp_${id}`, id)
      db.prepare("INSERT INTO proposals (id, repo_key, check_kind, branch, base_sha, head_sha, state, delivery, finding_ids, created_at, updated_at) VALUES (?, 'f~r', 'cve', ?, ?, ?, 'validating', 'branch', ?, 'now', 'now')").run(id, `lamplighter/cve/${id}`, base, head, JSON.stringify([`f_${id}`]))
      return getProposal(db, id)!
    }

    await validate(app, proposal('p_claim', unfixed), 'test')
    const pc = getProposal(db, 'p_claim')!
    expect(pc.state).toBe('failed')
    expect(JSON.parse(pc.validation!).scan.unfixed.join()).toMatch(/lodash@4\.17\.15/)

    await validate(app, proposal('p_fix', fixed), 'test')
    const pf = getProposal(db, 'p_fix')!
    const v = JSON.parse(pf.validation!)
    expect(v.mechanical).toMatchObject({ ran: true, ok: true })
    expect(v.scan).toMatchObject({ ran: true, ok: true, unfixed: [], introduced: [] })
    expect(pf.state).toBe('ready') // cve does not auto-submit by default: a person approves
  })
})
