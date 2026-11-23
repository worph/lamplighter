import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { anchorPath, fingerprint, reconcile, dismiss, getFinding } from './findings/index.js'
import { asOwnBranch, isOwnBranch, ownBranch } from './forges/refs.js'
import { checkRel } from './tools/workspace.js'
import { drift, lockPackages } from './checks/detectors/index.js'
import { classify, lastMessage, createClaudeCodeDriver } from './inference/claude-code.js'
import { createOpenAiDriver, completionsUrl } from './inference/openai.js'
import { extractJson } from './inference/index.js'
import { resolveSettings, type CheckDef } from './checks/index.js'
import { configSchema } from './config/index.js'
import { openDb } from './db/index.js'
import { GiteaForge } from './forges/gitea.js'
import { GitHubForge } from './forges/github.js'
import type { CredentialRow, ForgeRow } from './forges/types.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'll-'))
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd, encoding: 'utf8' }).trim()

describe('fingerprints', () => {
  it('ignore line numbers and case', () => {
    expect(fingerprint('docs', 'stale-readme', 'README.md:12')).toBe(fingerprint('docs', 'stale-readme', 'readme.md'))
    expect(fingerprint('docs', 'stale-readme', 'src/a.ts:3-9#foo')).toBe(fingerprint('docs', 'stale-readme', 'src/a.ts#foo'))
  })
  it('separate checks and categories', () => {
    expect(fingerprint('docs', 'a', 'x')).not.toBe(fingerprint('quality', 'a', 'x'))
    expect(fingerprint('docs', 'a', 'x')).not.toBe(fingerprint('docs', 'b', 'x'))
  })
  it('anchorPath strips symbol and lines', () => {
    expect(anchorPath('src/a.ts:12#foo')).toBe('src/a.ts')
    expect(anchorPath('npm:lodash@4.17.15')).toBe('npm:lodash@4.17.15')
  })
})

describe('own branches', () => {
  it('are always under lamplighter/', () => {
    const b = ownBranch('dead-code', 'Remove the unused file!', new Date('2026-11-19'), 'p_abcdef123456')
    expect(b).toBe('lamplighter/dead-code/remove-the-unused-file-20261119-123456')
    expect(isOwnBranch(b)).toBe(true)
  })
  it('refuse anything else', () => {
    expect(() => asOwnBranch('main')).toThrow()
    expect(() => asOwnBranch('lamplighter/../main')).toThrow()
    expect(() => asOwnBranch('feature/lamplighter/x')).toThrow()
  })
  it('the push module cannot force', () => {
    const src = readFileSync(new URL('./repos/push.ts', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
    expect(src).not.toMatch(/--force|-f['"]|force-with-lease|['"`]\+/)
  })
})

describe('workspace paths', () => {
  const wt = '/work/s1'
  it('stay inside the worktree', () => {
    expect(checkRel(wt, 'src/a.ts')).toBe('/work/s1/src/a.ts')
    expect(checkRel(wt, './README.md')).toBe('/work/s1/README.md')
    expect(() => checkRel(wt, '../s2/a')).toThrow()
    expect(() => checkRel(wt, '/etc/passwd')).toThrow()
    expect(() => checkRel(wt, '.git/config')).toThrow()
    expect(() => checkRel(wt, 'src/../../x')).toThrow()
  })
})

describe('detectors', () => {
  it('read lockfile v3 packages', () => {
    const m = lockPackages({ packages: { '': { version: '1.0.0' }, 'node_modules/a': { version: '1.2.3' }, 'node_modules/@s/b/node_modules/c': { version: '0.1.0' } } })
    expect([...m.keys()].sort()).toEqual(['@s/b/node_modules/c@0.1.0'.replace('@s/b/node_modules/', ''), 'a@1.2.3'].sort())
  })
  it('skip the root, workspace folders and links', () => {
    const m = lockPackages({ packages: { '': { version: '1.0.0' }, server: { version: '0.2.0' }, 'node_modules/@x/server': { version: '0.2.0', link: true }, 'node_modules/zod': { version: '3.25.76' } } })
    expect([...m.keys()]).toEqual(['zod@3.25.76'])
  })
  it('report major/minor drift only', () => {
    expect(drift('^4.17.1', '5.3.0')).toBe('major')
    expect(drift('4.17.15', '4.18.1')).toBe('minor')
    expect(drift('~1.2.3', '1.2.9')).toBeNull()
  })
})

describe('claude-code driver', () => {
  it('parses SSE and classifies failures', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"hi"}]}}\n\n'
    expect(lastMessage(sse)?.result?.content?.[0]?.text).toBe('hi')
    expect(classify(200, sse)).toBeUndefined()
    expect(classify(401, '')?.kind).toBe('auth')
    expect(classify(200, '{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"Unauthorized"}}')?.kind).toBe('auth')
    expect(classify(200, '{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"Unknown tool: x"}]}}')?.kind).toBe('missing')
  })
  it('wraps the call for a Beacon and treats a dead login as auth', async () => {
    let sent: { params: { name: string; arguments: { tool_name: string; arguments: Record<string, unknown> } } } | undefined
    const d = createClaudeCodeDriver({
      url: 'http://b/mcp', tool: 'claude-code__query_claude', via: 'beacon',
      fetchImpl: async (_u, body) => {
        sent = body as typeof sent
        return { status: 200, text: '{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Failed to authenticate: OAuth session expired"}]}}' }
      },
    })
    await expect(d.complete({ prompt: 'x' })).rejects.toMatchObject({ kind: 'auth' })
    expect(sent!.params.name).toBe('call')
    expect(sent!.params.arguments.tool_name).toBe('claude-code__query_claude')
    expect(sent!.params.arguments.arguments.prompt).toBe('x')
  })
})

describe('openai driver', () => {
  it('runs the tool loop until finish', async () => {
    const calls: string[] = []
    let done = false
    let turn = 0
    const d = createOpenAiDriver({
      url: 'http://x/v1', model: 'm', maxRounds: 10,
      fetchImpl: async (url, body) => {
        expect(url).toBe('http://x/v1/chat/completions')
        const b = body as { messages: { role: string }[]; tools: unknown[] }
        expect(b.tools.length).toBe(2)
        turn++
        const tc = turn === 1 ? { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } } : { id: 'b', type: 'function', function: { name: 'finish', arguments: '{"summary":"ok"}' } }
        return { status: 200, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [tc] } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }) }
      },
    })
    const r = await d.runSession({
      sessionId: 's', prompt: 'p', timeoutS: 30, callback: { url: '', token: '' },
      tools: [{ name: 'read_file', description: '', parameters: {} }, { name: 'finish', description: '', parameters: {} }],
      exec: async (name) => { calls.push(name); if (name === 'finish') done = true; return 'ok' },
      isDone: () => done,
    })
    expect(calls).toEqual(['read_file', 'finish'])
    expect(r.usage.tokens_in).toBe(10)
    expect(completionsUrl('http://x/v1/')).toBe('http://x/v1/chat/completions')
  })
})

describe('extractJson', () => {
  it('finds the object in prose and fences', () => {
    expect(extractJson('Sure!\n```json\n{"say":"a {b}","call":null}\n```')).toEqual({ say: 'a {b}', call: null })
    expect(extractJson('no json')).toBeUndefined()
  })
})

describe('settings precedence', () => {
  it('default → config → group → repo', () => {
    const def = { kind: 'docs', defaults: { enabled: true, delivery: 'push', auto_submit: true, armed: true, cadence_days: 7 } } as unknown as CheckDef
    const config = configSchema.parse({ checks: { docs: { delivery: 'pr' } } })
    const s = resolveSettings(def, config, { checks: { docs: { armed: false } } }, { checks: { docs: { delivery: 'branch' } } })
    expect(s).toMatchObject({ delivery: 'branch', armed: false, auto_submit: true, cadence_days: 7 })
    // No check is locked to `report`: a legacy `fixable: false` is ignored.
    const legacy = resolveSettings({ ...def, fixable: false } as unknown as CheckDef, config, {}, { checks: { docs: { delivery: 'pr' } } })
    expect(legacy.delivery).toBe('pr')
  })
})

describe('reconcile', () => {
  it('links repeats, keeps dismissals until the file changes, and retires what a full round no longer sees', async () => {
    const repo = tmp()
    sh(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'README.md'), 'v1\n')
    sh(repo, 'add', '-A'); sh(repo, 'commit', '-qm', 'one')
    const c1 = sh(repo, 'rev-parse', 'HEAD')
    const db = openDb(join(tmp(), 'db.sqlite'))
    db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('f','git','f','now')").run()
    db.prepare("INSERT INTO groups (id, name) VALUES ('default','default')").run()
    db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
    db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, created_at) VALUES ('f~r','f','default','','r','x','main','now')").run()
    const rec = (title: string, anchor = 'README.md') => ({ category: 'stale-readme', anchor, title, body: '', severity: 'minor' as const })
    const base = { repo: 'f~r', check: 'docs', sensitive: false, worktree: repo }
    const r1 = await reconcile(db, { ...base, roundId: 'r1', scope: 'full', commit: c1, recorded: [rec('old command'), rec('other', 'docs/x.md')] })
    expect(r1.created).toBe(2)
    const r2 = await reconcile(db, { ...base, roundId: 'r2', scope: 'full', commit: c1, recorded: [rec('old command, reworded')] })
    expect(r2.created).toBe(0)
    expect(r2.updated).toBe(1)
    expect(r2.gone).toBe(1)
    const id = r2.ids[0]!
    dismiss(db, id, 'intentional', 'test')
    const r3 = await reconcile(db, { ...base, roundId: 'r3', scope: 'diff', commit: c1, recorded: [rec('old command')] })
    expect(r3.stillDismissed).toBe(1)
    expect(getFinding(db, id)!.state).toBe('dismissed')
    mkdirSync(join(repo, 'docs'), { recursive: true })
    writeFileSync(join(repo, 'README.md'), 'v2\n')
    sh(repo, 'commit', '-qam', 'two')
    const c2 = sh(repo, 'rev-parse', 'HEAD')
    const r4 = await reconcile(db, { ...base, roundId: 'r4', scope: 'diff', commit: c2, recorded: [rec('old command')] })
    expect(r4.reopened).toBe(1)
    expect(getFinding(db, id)!.state).toBe('open')
  })
})

describe('forge REST clients', () => {
  const row = (kind: 'github' | 'gitea', base: string | null): ForgeRow => ({ id: kind, kind, name: kind, base_url: base, webhook_secret: null, created_at: '' })
  const cred: CredentialRow = { id: 'c', forge_id: 'f', label: 'c', username: 'u', token: 't', token_set_at: null, auth_json: null, commit_name: null, commit_email: null, is_default: 1, created_at: '' }
  it('Gitea opens a labelled PR', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(`${init.method} ${new URL(url).pathname}`)
      expect((init.headers as Record<string, string>).authorization).toBe('token t')
      const p = new URL(url).pathname
      const body = p.endsWith('/labels') && init.method === 'GET' ? [] : p.endsWith('/labels') ? { id: 7 } : { number: 3, html_url: 'http://g/pr/3' }
      if (p.endsWith('/pulls')) expect(JSON.parse(init.body as string).labels).toEqual([7])
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const pr = await new GiteaForge(row('gitea', 'http://g'), cred, fetchImpl).openPr('o', 'r', { head: 'lamplighter/x/y', base: 'main', title: 't', body: 'b' })
    expect(pr).toEqual({ number: 3, url: 'http://g/pr/3' })
    expect(seen).toEqual(['GET /api/v1/repos/o/r/labels', 'POST /api/v1/repos/o/r/labels', 'POST /api/v1/repos/o/r/pulls'])
  })
  it('GitHub reads visibility and PR state', async () => {
    const fetchImpl = (async (url: string) => {
      const p = new URL(url).pathname
      const body = p.endsWith('/pulls/9') ? { state: 'closed', merged: true } : { name: 'r', owner: { login: 'o' }, default_branch: 'dev', private: false, clone_url: 'x' }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const gh = new GitHubForge(row('github', null), cred, fetchImpl)
    expect(await gh.repoInfo('o', 'r')).toMatchObject({ defaultBranch: 'dev', visibility: 'public' })
    expect(await gh.prState('o', 'r', 9)).toBe('merged')
    expect(gh.gitAuth()['http.extraHeader']).toMatch(/^Authorization: Basic /)
  })
})

describe('forge credentials and write access', () => {
  const setup = () => {
    const db = openDb(join(tmp(), 'db.sqlite'))
    db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('github','github','GitHub','now')").run()
    db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
    const addRepo = (owner: string, name: string) =>
      db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, visibility, created_at) VALUES (?, 'github', 'default', ?, ?, 'x', 'main', 'public', 'now')").run(`github~${owner}/${name}`, owner, name)
    addRepo('o', 'r')
    const app = { db, config: { current: configSchema.parse({}) } } as unknown as import('./context.js').App
    const repoRow = (key = 'github~o/r') => db.prepare('SELECT * FROM repos WHERE key = ?').get(key) as { forge_id: string; owner: string; name: string; group_id: string; credential_id: string | null }
    return { db, app, addRepo, repoRow }
  }
  /**
   * GitHub as seen by each token: `who` maps a token to its account and, per `owner/name`, whether
   * the account may push and whether the token was given Contents. Anything else is a 404.
   */
  const fakeGitHub = (who: Record<string, { login: string; id: number; repos: Record<string, [accountPush: boolean, contents: boolean]> }>) =>
    (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
      const token = ((init?.headers as Record<string, string> | undefined)?.authorization ?? '').replace(/^Bearer /, '')
      const me = who[token]
      if (!me) return json(401, { message: 'Bad credentials' })
      if (path === '/user') return json(200, { login: me.login, id: me.id })
      const m = /^\/repos\/([^/]+\/[^/]+)(\/git\/blobs)?$/.exec(path)
      const grant = m ? me.repos[m[1]!] : undefined
      if (!grant) return json(404, { message: 'Not Found' })
      if (!m![2]) return json(200, { permissions: { push: grant[0] } })
      return grant[1] ? json(422, { message: 'Invalid request' }) : json(403, { message: 'Resource not accessible by personal access token' })
    }) as typeof fetch
  const openAlerts = (db: ReturnType<typeof setup>['db']) => (db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'alert' AND state = 'open'").get() as { n: number }).n

  it('normalizes a pasted token and refuses what is not one', async () => {
    const { normalizeToken } = await import('./forges/auth.js')
    expect(normalizeToken('  github_pat_abc \n')).toBe('github_pat_abc')
    expect(() => normalizeToken('two words')).toThrow(/one word/)
    expect(() => normalizeToken('')).toThrow(/required|empty/)
  })

  it('blocks fixing without a token, and until the token may push to the repo', async () => {
    const { addCredential, setCredentialToken, writeAccess, deliveryBlocker, commitIdentity, forgeView } = await import('./forges/auth.js')
    const { forgeRow } = await import('./forges/index.js')
    const { db, app, repoRow } = setup()
    expect(writeAccess(app, repoRow())).toMatchObject({ ok: false, why: expect.stringMatching(/no credential/) })
    const bot = addCredential(app, 'github', { label: 'Bot' })
    expect(bot.is_default).toBe(1) // the forge's first credential is its default
    expect(writeAccess(app, repoRow())).toMatchObject({ ok: false, why: expect.stringMatching(/no token/) })

    const real = globalThis.fetch
    try {
      globalThis.fetch = fakeGitHub({ pat_x: { login: 'bot', id: 42, repos: { 'o/r': [true, false] } } })
      const failing = await setCredentialToken(app, bot.id, 'pat_x', 'test')
      expect(failing.state).toBe('ok') // the token works; it just cannot write here
      expect(writeAccess(app, repoRow())).toMatchObject({ ok: false, why: expect.stringMatching(/Contents/) })
      expect(deliveryBlocker(app, repoRow())).toMatch(/Contents/)
      expect(openAlerts(db)).toBe(1) // one alert per forge

      globalThis.fetch = fakeGitHub({ pat_y: { login: 'bot', id: 42, repos: { 'o/r': [true, true] } } })
      await setCredentialToken(app, bot.id, 'pat_y', 'test')
      expect(writeAccess(app, repoRow()).ok).toBe(true)
      expect(deliveryBlocker(app, repoRow())).toBeUndefined()
      expect(openAlerts(db)).toBe(0)
      // The default identity gives way to the token account's noreply address.
      expect(commitIdentity(app, repoRow())).toEqual({ name: 'Lamplighter', email: '42+bot@users.noreply.github.com' })

      globalThis.fetch = fakeGitHub({ pat_z: { login: 'bot', id: 42, repos: { 'o/r': [false, true] } } })
      await setCredentialToken(app, bot.id, 'pat_z', 'test')
      expect(writeAccess(app, repoRow())).toMatchObject({ ok: false, why: expect.stringMatching(/account cannot push/) })

      globalThis.fetch = fakeGitHub({})
      const refused = await setCredentialToken(app, bot.id, 'pat_gone', 'test')
      expect(refused).toMatchObject({ state: 'failing', problems: [expect.stringMatching(/refused the token/)] })
    } finally {
      globalThis.fetch = real
    }
    // Tokens never leave the server: the view the Settings page gets has no token in it.
    expect(JSON.stringify(forgeView(db, forgeRow(db, 'github')))).not.toMatch(/pat_/)
  })

  it('gives each repo the credential that may push there, unless one is pinned', async () => {
    const { addCredential, setCredentialToken, credentialFor, writeAccess, commitIdentity, patchCredential } = await import('./forges/auth.js')
    const { db, app, addRepo, repoRow } = setup()
    addRepo('acme', 'site')
    const me = addCredential(app, 'github', { label: 'Me' })
    const org = addCredential(app, 'github', { label: 'Acme org', commit_name: 'Acme Bot', commit_email: 'bot@acme.example' })
    const real = globalThis.fetch
    try {
      // One fine-grained token per resource owner: neither reaches the other's repos.
      globalThis.fetch = fakeGitHub({
        pat_me: { login: 'me', id: 1, repos: { 'o/r': [true, true] } },
        pat_org: { login: 'me', id: 1, repos: { 'acme/site': [true, true] } },
      })
      await setCredentialToken(app, me.id, 'pat_me', 'test')
      await setCredentialToken(app, org.id, 'pat_org', 'test')
      const mine = repoRow('github~o/r')
      const theirs = repoRow('github~acme/site')
      expect(credentialFor(db, mine)).toMatchObject({ cred: { id: me.id }, via: 'auto' })
      expect(credentialFor(db, theirs)).toMatchObject({ cred: { id: org.id }, via: 'auto' })
      expect(writeAccess(app, mine).ok && writeAccess(app, theirs).ok).toBe(true)
      expect(openAlerts(db)).toBe(0) // a token that cannot reach the other owner is not a fault
      // Each credential signs its own commits; one without a name of its own uses the global one.
      expect(commitIdentity(app, theirs)).toEqual({ name: 'Acme Bot', email: 'bot@acme.example' })
      expect(commitIdentity(app, mine)).toEqual({ name: 'Lamplighter', email: '1+me@users.noreply.github.com' })

      // A pin wins over auto, even when it cannot push — and says so.
      db.prepare('UPDATE repos SET credential_id = ? WHERE key = ?').run(me.id, 'github~acme/site')
      expect(credentialFor(db, repoRow('github~acme/site'))).toMatchObject({ cred: { id: me.id }, via: 'repo' })
      expect(writeAccess(app, repoRow('github~acme/site'))).toMatchObject({ ok: false, why: expect.stringMatching(/pinned on the repository/) })
      // A group pin applies below the repo's own.
      db.prepare('UPDATE repos SET credential_id = NULL').run()
      db.prepare("UPDATE groups SET credential_id = ? WHERE id = 'default'").run(org.id)
      expect(credentialFor(db, repoRow('github~o/r'))).toMatchObject({ cred: { id: org.id }, via: 'group' })
      db.prepare("UPDATE groups SET credential_id = NULL WHERE id = 'default'").run()

      // A repo nobody can push to names what every credential answered.
      addRepo('elsewhere', 'x')
      await setCredentialToken(app, me.id, 'pat_me', 'test')
      expect(writeAccess(app, repoRow('github~elsewhere/x'))).toMatchObject({ ok: false, why: expect.stringMatching(/no GitHub credential may push.*Me.*Acme org/) })
      expect(openAlerts(db)).toBe(1)
      // Making another credential the default moves the fallback, not the auto choices.
      patchCredential(app, org.id, { is_default: true })
      expect(credentialFor(db, repoRow('github~elsewhere/x'))).toMatchObject({ cred: { id: org.id }, via: 'default' })
      expect(credentialFor(db, repoRow('github~o/r'))).toMatchObject({ cred: { id: me.id }, via: 'auto' })
    } finally {
      globalThis.fetch = real
    }
  })
})
