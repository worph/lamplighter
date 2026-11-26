import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { applyRules, personDecides, policyChanged, precedents, watchAdmission } from './admission/index.js'
import { runArbitration } from './admission/arbiter.js'
import { lamps } from './api/index.js'
import { Checks } from './checks/index.js'
import { configSchema } from './config/index.js'
import type { App } from './context.js'
import { openDb } from './db/index.js'
import { decide, decisionsOf, getFinding, reconcile, type FindingRow } from './findings/index.js'
import { writeAccess } from './forges/auth.js'
import { Mirrors } from './repos/mirror.js'
import { getRepo } from './repos/registry.js'
import type { QueueRow } from './sessions/engine.js'
import { SessionRegistry } from './sessions/session.js'
import { LocalWorkspace } from './sessions/workspace.js'
import { execTool, toolSpecs } from './tools/workspace.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'll-adm-'))
const seed = fileURLToPath(new URL('../../seed', import.meta.url))

/** A repo with an origin to fetch from, the seed checks, and no inference unless a test sets it. */
function setup(config: Record<string, unknown> = {}) {
  const origin = tmp()
  const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: origin, encoding: 'utf8' }).trim()
  g('init', '-q', '-b', 'main')
  writeFileSync(join(origin, 'README.md'), '# fx\n')
  g('add', '-A')
  g('commit', '-qm', 'base')
  const data = tmp()
  const db = openDb(join(data, 'db.sqlite'))
  db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('f','git','f','now')").run()
  db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
  for (const key of ['f~r', 'f~other']) {
    db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, created_at) VALUES (?,'f','default','',?,?,'main','now')").run(key, key.slice(2), origin)
  }
  const app = {
    db, config: { current: configSchema.parse(config) }, checks: new Checks(join(data, 'checks'), seed), mirrors: new Mirrors(db, data),
    sessions: new SessionRegistry(), kick: () => undefined,
  } as unknown as App
  let n = 0
  const finding = (f: Partial<FindingRow> & { check_kind: string }) => {
    const id = f.id ?? `f${++n}`
    db.prepare(
      `INSERT INTO findings (id, repo_key, check_kind, fingerprint, category, anchor, title, body, severity, sensitive, state, input_hash, first_round, last_round, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'README.md', ?, '', ?, ?, ?, 'h', 'r0', 'r0', ?, ?, ?)`,
    ).run(id, f.repo_key ?? 'f~r', f.check_kind, `fp_${id}`, f.category ?? 'c', f.title ?? `finding ${id}`, f.severity ?? 'minor', f.sensitive ?? 0, f.state ?? 'open', f.source ?? 'round', `2026-01-0${n}`, 'now')
    return id
  }
  const state = (id: string) => getFinding(db, id)!.state
  const queued = (job: string) => db.prepare("SELECT * FROM queue WHERE job = ? AND state = 'queued'").all(job) as QueueRow[]
  return { app, db, origin, g, finding, state, queued, repo: () => getRepo(db, 'f~r') }
}

describe('admission rules', () => {
  it('admit always, defer manual, and leave the rest for the arbiter', () => {
    const { app, finding, state, repo } = setup()
    const cve = finding({ check_kind: 'cve' })
    const arch = finding({ check_kind: 'architecture' })
    const docs = finding({ check_kind: 'docs' })
    const secMajor = finding({ check_kind: 'security', severity: 'major', sensitive: 1 })
    const secMinor = finding({ check_kind: 'security', severity: 'minor', sensitive: 1 })
    expect(applyRules(app, repo(), [cve, arch, docs, secMajor, secMinor])).toBe(2)
    expect([state(cve), state(arch), state(docs), state(secMajor), state(secMinor)]).toEqual(['admitted', 'deferred', 'open', 'admitted', 'open'])
  })

  it('follow a repo override, and re-judge when the effective setting moves', () => {
    const { app, db, finding, state, repo, queued } = setup()
    const arch = finding({ check_kind: 'architecture' })
    applyRules(app, repo(), [arch])
    expect(state(arch)).toBe('deferred')
    watchAdmission(app, 'architecture', [repo()], () =>
      db.prepare('UPDATE repos SET settings_json = ? WHERE key = ?').run(JSON.stringify({ checks: { architecture: { admission: 'always' } } }), 'f~r'),
    )
    expect(state(arch)).toBe('admitted')
    // Same effective setting written again: nothing is judged anew.
    const before = decisionsOf(db, arch).length
    watchAdmission(app, 'architecture', [repo()], () => undefined)
    expect(decisionsOf(db, arch).length).toBe(before)
    expect(queued('arbitrate')).toHaveLength(0)
  })
})

describe('decisions', () => {
  it('refuse to decline a sensitive finding unless a person does, and judge only what is open', () => {
    const { app, db, finding } = setup()
    const sec = finding({ check_kind: 'security', sensitive: 1 })
    expect(() => decide(db, { id: sec, decision: 'decline', by: 'arbiter', actor: 'arbiter', rationale: 'not real' })).toThrow(/defer it/)
    decide(db, { id: sec, decision: 'defer', by: 'arbiter', actor: 'arbiter', rationale: 'needs a person' })
    expect(() => decide(db, { id: sec, decision: 'admit', by: 'arbiter', actor: 'arbiter', rationale: 'changed my mind' })).toThrow(/deferred/)
    expect(personDecides(app, sec, 'take', '', 'operator').state).toBe('admitted')
  })

  it("make a person's take a precedent: similar findings the arbiter put aside are judged again", () => {
    const { app, db, finding, state, queued } = setup()
    const a = finding({ check_kind: 'refactor', category: 'duplication' })
    const b = finding({ check_kind: 'refactor', category: 'duplication' })
    const other = finding({ check_kind: 'refactor', category: 'naming' })
    const ruled = finding({ check_kind: 'architecture', category: 'duplication' })
    for (const id of [a, b, other]) decide(db, { id, decision: 'defer', by: 'arbiter', actor: 'arbiter', rationale: 'too large for now' })
    decide(db, { id: ruled, decision: 'defer', by: 'rule', actor: 'lamplighter', rationale: 'manual' })
    personDecides(app, a, 'take', 'worth it', 'operator')
    expect([state(a), state(b), state(other), state(ruled)]).toEqual(['admitted', 'open', 'deferred', 'deferred'])
    expect(queued('arbitrate')).toHaveLength(1)
    // The MCP is not a person: its take sets no precedent.
    decide(db, { id: b, decision: 'defer', by: 'arbiter', actor: 'arbiter', rationale: 'again' })
    personDecides(app, other, 'take', '', 'mcp')
    expect(state(b)).toBe('deferred')
    expect(decisionsOf(db, other)[0]!.by).toBe('mcp')
  })

  it('reopen what the arbiter put aside when the policy changes', () => {
    const { app, db, finding, state } = setup()
    const a = finding({ check_kind: 'quality' })
    decide(db, { id: a, decision: 'decline', by: 'arbiter', actor: 'arbiter', rationale: 'taste, not policy' })
    expect(policyChanged(app, { group: 'default' })).toBe(1)
    expect(state(a)).toBe('open')
  })
})

describe('reconcile under admission', () => {
  it('holds a deferral on the same input, reopens it when the input changes, and never retires another source', async () => {
    const { db, origin, g, finding, state } = setup()
    const c1 = g('rev-parse', 'HEAD')
    const blob = g('rev-parse', `${c1}:README.md`)
    const base = { repo: 'f~r', check: 'docs', revision: 1, cadenceDays: 7, sensitive: false, worktree: origin }
    const rec = { category: 'stale-readme', anchor: 'README.md', title: 'stale', body: '', severity: 'minor' as const }
    const r1 = await reconcile(db, { ...base, roundId: 'r1', scope: 'full', commit: c1, recorded: [rec] })
    const id = r1.ids[0]!
    const fromIssue = finding({ check_kind: 'docs', source: 'issue', state: 'admitted' })
    decide(db, { id, decision: 'defer', by: 'arbiter', actor: 'arbiter', rationale: 'later', checkRevision: 1 })
    expect(getFinding(db, id)!.input_hash).toBe(blob)

    const r2 = await reconcile(db, { ...base, roundId: 'r2', scope: 'full', commit: c1, recorded: [rec] })
    expect(r2.held).toBe(1)
    expect(state(id)).toBe('deferred')
    expect(state(fromIssue)).toBe('admitted') // a full docs round is not authoritative for an issue

    const r3 = await reconcile(db, { ...base, revision: 2, roundId: 'r3', scope: 'diff', commit: c1, recorded: [rec] })
    expect(r3.reopened).toBe(1)
    expect(state(id)).toBe('open')
    expect(decisionsOf(db, id)[0]).toMatchObject({ decision: 'reopen', by: 'rule' })

    decide(db, { id, decision: 'admit', by: 'arbiter', actor: 'arbiter', rationale: 'now', checkRevision: 2 })
    writeFileSync(join(origin, 'README.md'), '# fx, changed\n')
    g('commit', '-qam', 'two')
    await reconcile(db, { ...base, roundId: 'r4', scope: 'diff', commit: g('rev-parse', 'HEAD'), recorded: [rec] })
    expect(state(id)).toBe('admitted') // wanted work stays wanted
  })
})

describe('lamps', () => {
  it('dim on work left, not on what was put aside, which they count', () => {
    const { app, db, finding } = setup()
    db.prepare("INSERT INTO rounds (id, repo_key, check_kind, check_revision, kind, scope, head_sha, trigger, status, started_at) VALUES ('r1','f~r','docs',1,'round','full','h','t','done','now'), ('r2','f~r','quality',1,'round','full','h','t','done','now')").run()
    finding({ check_kind: 'docs', state: 'deferred' })
    finding({ check_kind: 'docs', state: 'declined' })
    finding({ check_kind: 'quality', state: 'admitted' })
    const l = lamps(app, 'f~r')
    expect(l.docs).toMatchObject({ lamp: 'lit', open: 0, later: 2 })
    expect(l.quality).toMatchObject({ lamp: 'dim', open: 1, later: 0 })
  })
})

describe('precedents', () => {
  it('come closest first, a person before the arbiter', () => {
    const { app, db, finding, repo } = setup()
    const cand = finding({ check_kind: 'refactor', category: 'dup' })
    const sameArb = finding({ check_kind: 'refactor', category: 'dup', state: 'fixed' })
    const sameUser = finding({ check_kind: 'refactor', category: 'dup', state: 'fixed' })
    const elsewhere = finding({ check_kind: 'refactor', category: 'dup', repo_key: 'f~other', state: 'fixed' })
    const unrelated = finding({ check_kind: 'docs', category: 'dup', state: 'fixed' })
    const ins = db.prepare("INSERT INTO decisions (id, finding_id, decision, by, actor, rationale, input_hash, check_revision, at) VALUES (?, ?, 'defer', ?, 'x', 'r', 'h', 1, ?)")
    ins.run('d_arb', sameArb, 'arbiter', '2026-03-01')
    ins.run('d_user', sameUser, 'user', '2026-02-01')
    ins.run('d_else', elsewhere, 'user', '2026-04-01')
    ins.run('d_unrel', unrelated, 'user', '2026-04-01')
    ins.run('d_rule', sameArb, 'rule', '2026-04-01')
    expect(precedents(app, repo(), [getFinding(db, cand)!]).map((p) => p.id)).toEqual(['d_user', 'd_arb', 'd_else'])
  })
})

describe('the arbiter session', () => {
  it('only reads and decides', async () => {
    const { app, origin, repo } = setup()
    const s = app.sessions.open({
      id: 'r', kind: 'arbiter', repo: repo(), worktree: origin, ws: new LocalWorkspace(origin), head: 'HEAD', allowWrite: false, timeoutS: 60, runTimeoutS: 10,
      arbiter: { candidates: new Map([['f1', { sensitive: true }]]), precedents: new Set(['d1']), decisions: [] },
    })
    expect(toolSpecs(s).map((t) => t.name).sort()).toEqual(['cannot', 'decide', 'finish', 'git_log', 'grep', 'list_files', 'read_file'])
    await expect(execTool(s, 'record_finding', { category: 'c', anchor: 'a', title: 'abc' })).rejects.toThrow(/not available/)
    await expect(execTool(s, 'decide', { finding_id: 'f1', decision: 'decline', rationale: 'not worth doing' })).rejects.toThrow(/defer it/)
    await expect(execTool(s, 'decide', { finding_id: 'f1', decision: 'defer', rationale: 'needs a person', precedents: ['d9'] })).rejects.toThrow(/not precedents/)
    await execTool(s, 'decide', { finding_id: 'f1', decision: 'defer', rationale: 'needs a person', precedents: ['d1'] })
    await expect(execTool(s, 'decide', { finding_id: 'f1', decision: 'admit', rationale: 'second thoughts' })).rejects.toThrow(/already decided/)
  })
})

describe('arbitration', () => {
  let server: Server | undefined
  afterAll(() => server?.close())

  it('applies what the arbiter decided, leaves the rest open, and starts fixing what it admitted', async () => {
    const prompts: string[] = []
    let turn = 0
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const msgs = (JSON.parse(body) as { messages: { content: string | null }[] }).messages
        if (turn === 0) prompts.push(msgs.map((m) => m.content ?? '').join('\n'))
        const calls = [
          { name: 'decide', arguments: JSON.stringify({ finding_id: 'fa', decision: 'admit', rationale: 'A small, clear docs fix.' }) },
          { name: 'decide', arguments: JSON.stringify({ finding_id: 'fb', decision: 'defer', rationale: 'Overlaps the admitted docs fix.' }) },
          { name: 'finish', arguments: JSON.stringify({ summary: 'Admitted one, deferred one.' }) },
        ]
        const c = calls[Math.min(turn++, calls.length - 1)]!
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `t${turn}`, type: 'function', function: c }] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const { app, db, finding, state, queued, repo } = setup({ inference: { driver: 'openai', url: `http://127.0.0.1:${port}/v1`, model: 'm', timeout_s: 60 } })
    finding({ id: 'fa', check_kind: 'docs', title: 'README names a removed command' })
    finding({ id: 'fb', check_kind: 'docs', title: 'README section order' })
    finding({ id: 'fc', check_kind: 'quality', title: 'left for later' })
    const job = { id: 'q1', job: 'arbitrate', repo_key: 'f~r', check_kind: '*', scope: 'full', trigger: 'round' } as QueueRow
    const roundId = await runArbitration(app, job)

    expect(prompts[0]).toContain('[fa] README names a removed command')
    expect(prompts[0]).toContain('this check leans ADMIT')
    expect([state('fa'), state('fb'), state('fc')]).toEqual(['admitted', 'deferred', 'open'])
    expect(decisionsOf(db, 'fa')[0]).toMatchObject({ by: 'arbiter', decision: 'admit', session_id: roundId })
    const round = db.prepare('SELECT kind, status, summary, report FROM rounds WHERE id = ?').get(roundId) as { kind: string; status: string; summary: string; report: string }
    expect(round).toMatchObject({ kind: 'arbitrate', status: 'done', summary: '1 admitted · 1 not now · 0 declined · 1 undecided' })
    expect(round.report).toContain('[fc] left for later')
    // docs is armed by default: what was admitted goes to a fixer, when Lamplighter may write here.
    expect(queued('author').map((j) => j.check_kind)).toEqual(writeAccess(app, repo()).ok ? ['docs'] : [])
  })
})
