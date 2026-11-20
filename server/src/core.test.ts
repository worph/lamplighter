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
import type { ForgeRow } from './forges/types.js'

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
  const row = (kind: 'github' | 'gitea', base: string | null): ForgeRow => ({ id: kind, kind, name: kind, base_url: base, username: 'u', token: 't', webhook_secret: null, created_at: '' })
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
    const pr = await new GiteaForge(row('gitea', 'http://g'), fetchImpl).openPr('o', 'r', { head: 'lamplighter/x/y', base: 'main', title: 't', body: 'b' })
    expect(pr).toEqual({ number: 3, url: 'http://g/pr/3' })
    expect(seen).toEqual(['GET /api/v1/repos/o/r/labels', 'POST /api/v1/repos/o/r/labels', 'POST /api/v1/repos/o/r/pulls'])
  })
  it('GitHub reads visibility and PR state', async () => {
    const fetchImpl = (async (url: string) => {
      const p = new URL(url).pathname
      const body = p.endsWith('/pulls/9') ? { state: 'closed', merged: true } : { name: 'r', owner: { login: 'o' }, default_branch: 'dev', private: false, clone_url: 'x' }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as unknown as typeof fetch
    const gh = new GitHubForge(row('github', null), fetchImpl)
    expect(await gh.repoInfo('o', 'r')).toMatchObject({ defaultBranch: 'dev', visibility: 'public' })
    expect(await gh.prState('o', 'r', 9)).toBe('merged')
    expect(gh.gitAuth()['http.extraHeader']).toMatch(/^Authorization: Basic /)
  })
})

describe('forge tokens and write access', () => {
  const setup = () => {
    const db = openDb(join(tmp(), 'db.sqlite'))
    db.prepare("INSERT INTO forges (id, kind, name, created_at) VALUES ('github','github','GitHub','now')").run()
    db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default','Default','')").run()
    db.prepare("INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, visibility, created_at) VALUES ('github~o/r','github','default','o','r','https://github.com/o/r.git','main','public','now')").run()
    const app = { db, config: { current: configSchema.parse({}) } } as unknown as import('./context.js').App
    const repo = { forge_id: 'github', owner: 'o', name: 'r' }
    return { db, app, repo }
  }
  /** GitHub as seen by a token whose account may (or may not) push, and whose grant does (or does not) include Contents. */
  const fakeGitHub = (accountPush: boolean, contents: boolean) =>
    (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
      if (path === '/user') return json(200, { login: 'bot', id: 42 })
      if (path === '/repos/o/r') return json(200, { permissions: { push: accountPush } })
      if (path === '/repos/o/r/git/blobs' && init?.method === 'POST') return contents ? json(422, { message: 'Invalid request' }) : json(403, { message: 'Resource not accessible by personal access token' })
      return json(404, { message: 'Not Found' })
    }) as typeof fetch

  it('normalizes a pasted token and refuses what is not one', async () => {
    const { normalizeToken } = await import('./forges/auth.js')
    expect(normalizeToken('  github_pat_abc \n')).toBe('github_pat_abc')
    expect(() => normalizeToken('two words')).toThrow(/one word/)
    expect(() => normalizeToken('')).toThrow(/required|empty/)
  })

  it('blocks fixing without a token, and until the token may push to the repo', async () => {
    const { setForgeToken, writeAccess, deliveryBlocker, commitIdentity } = await import('./forges/auth.js')
    const { forgeRow } = await import('./forges/index.js')
    const { db, app, repo } = setup()
    expect(writeAccess(app, repo)).toMatchObject({ ok: false, why: expect.stringMatching(/no token/) })

    const real = globalThis.fetch
    try {
      globalThis.fetch = fakeGitHub(true, false)
      const failing = await setForgeToken(app, 'github', 'github_pat_x', 'test')
      expect(failing.state).toBe('failing')
      expect(writeAccess(app, repo)).toMatchObject({ ok: false, why: expect.stringMatching(/Contents/) })
      expect(deliveryBlocker(forgeRow(db, 'github'), 'o/r')).toMatch(/Contents/)
      // One alert per forge, opened by the failing check and closed by the working one.
      const openAlerts = () => (db.prepare("SELECT COUNT(*) AS n FROM activity WHERE kind = 'alert' AND state = 'open'").get() as { n: number }).n
      expect(openAlerts()).toBe(1)

      globalThis.fetch = fakeGitHub(true, true)
      const ok = await setForgeToken(app, 'github', 'github_pat_y', 'test')
      expect(ok).toMatchObject({ state: 'ok', login: 'bot', user_id: 42 })
      expect(writeAccess(app, repo).ok).toBe(true)
      expect(deliveryBlocker(forgeRow(db, 'github'), 'o/r')).toBeUndefined()
      expect(openAlerts()).toBe(0)
      // The default identity gives way to the token account's noreply address.
      expect(commitIdentity(app, 'github')).toEqual({ name: 'Lamplighter', email: '42+bot@users.noreply.github.com' })

      globalThis.fetch = fakeGitHub(false, true)
      await setForgeToken(app, 'github', 'github_pat_z', 'test')
      expect(writeAccess(app, repo)).toMatchObject({ ok: false, why: expect.stringMatching(/account cannot push/) })
    } finally {
      globalThis.fetch = real
    }
    // The token never leaves the server: the view the Settings page gets has no token field.
    const { forgeView } = await import('./forges/auth.js')
    expect(JSON.stringify(forgeView(forgeRow(db, 'github')))).not.toContain('github_pat')
  })
})
