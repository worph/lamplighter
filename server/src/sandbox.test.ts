import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { sandboxSchema } from './config/index.js'
import { SessionRegistry, type Session } from './sessions/session.js'
import { LocalWorkspace, lexicalRel, type Workspace } from './sessions/workspace.js'
import { execTool, toolSpecs } from './tools/workspace.js'
import type { CheckDef } from './checks/index.js'
import type { RepoRow } from './repos/registry.js'
import { repoEnv } from './sandbox/repo.js'
import { SandboxRuntime } from './sandbox/runtime.js'
import { chownSpec, detectorSpec, sessionSpec } from './sandbox/spec.js'
import { openSandbox, type SandboxWorkspace } from './sandbox/workspace.js'

const cfg = sandboxSchema.parse({ enabled: true })

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'll-sb-'))
}

function write(root: string, files: Record<string, string>): string {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

describe('sandbox specs (architecture §10.1)', () => {
  const all = [
    sessionSpec(cfg, { sessionId: 'r_abc', image: 'img' }),
    detectorSpec(cfg, { sessionId: 'r_abc', image: 'scanner', argv: ['scan'] }),
    chownSpec(cfg, { volume: 'v', image: 'img' }),
  ]

  it('never bind the host, never pass the socket, drop every capability', () => {
    for (const spec of all) {
      const hc = spec.HostConfig!
      expect(hc.Binds).toBeUndefined()
      expect(hc.CapDrop).toEqual(['ALL'])
      expect(hc.SecurityOpt).toContain('no-new-privileges')
      expect(hc.Privileged).toBeUndefined()
      for (const m of hc.Mounts ?? []) expect(m.Type).toBe('volume')
      expect(JSON.stringify(spec)).not.toMatch(/docker\.sock|\/DATA/)
    }
  })

  it('run as the sandbox uid on the sandbox network, with nothing of our environment', () => {
    const s = all[0]!
    expect(s.User).toBe('10001:10001')
    expect(s.HostConfig!.NetworkMode).toBe('lamplighter-sandbox')
    expect(s.HostConfig!.Memory).toBe(2048 * 1024 * 1024)
    expect(s.HostConfig!.PidsLimit).toBe(512)
    const env = (s.Env ?? []).join('\n')
    expect(env).not.toMatch(/TOKEN|BEARER|LAMPLIGHTER_|SECRET/i)
  })

  it('give a scanner the clone read-only, and the chown helper CHOWN alone without network', () => {
    expect(all[1]!.HostConfig!.Mounts).toEqual([expect.objectContaining({ Target: '/work', ReadOnly: true })])
    expect(all[2]!.HostConfig!.CapAdd).toEqual(['CHOWN'])
    expect(all[2]!.HostConfig!.NetworkMode).toBe('none')
  })
})

describe('repository environment', () => {
  it('detects npm install and tests, and ignores npm\'s placeholder test script', () => {
    const a = write(tmp(), { 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }), 'package-lock.json': '{}' })
    expect(repoEnv(a)).toMatchObject({ image: null, imageFrom: 'default', install: ['npm ci --no-audit --no-fund'], test: ['npm test'], testsFrom: 'detected' })
    const b = write(tmp(), { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) })
    expect(repoEnv(b)).toMatchObject({ test: [], testsFrom: 'none' })
  })

  it('detects a Python project with pytest', () => {
    const r = write(tmp(), { 'requirements.txt': 'requests==2.25.0\n', 'requirements-dev.txt': 'pytest==8.3.4\n' })
    const env = repoEnv(r)
    expect(env.install).toEqual(['python -m venv .venv && .venv/bin/pip install -q -r requirements-dev.txt -r requirements.txt'])
    expect(env.test).toEqual(['.venv/bin/python -m pytest -q'])
  })

  it('takes LAMPLIGHTER.md first, then container-use, then the devcontainer image', () => {
    const r = write(tmp(), {
      'LAMPLIGHTER.md': '---\nsandbox:\n  image: node:22-bookworm-slim\n  test: [npm run check]\n---\n# Notes\n',
      '.devcontainer/devcontainer.json': '{ // comment\n "image": "mcr.microsoft.com/devcontainers/base", }',
      'package.json': '{}',
    })
    expect(repoEnv(r)).toMatchObject({ image: 'node:22-bookworm-slim', imageFrom: 'LAMPLIGHTER.md', test: ['npm run check'], testsFrom: 'LAMPLIGHTER.md' })
    const d = write(tmp(), { '.devcontainer/devcontainer.json': '{ /* c */ "image": "mcr.microsoft.com/devcontainers/base", }' })
    expect(repoEnv(d)).toMatchObject({ image: 'mcr.microsoft.com/devcontainers/base', imageFrom: '.devcontainer' })
    const c = write(tmp(), { '.container-use/environment.json': JSON.stringify({ base_image: 'ubuntu:24.04', install_commands: ['make deps'] }) })
    expect(repoEnv(c)).toMatchObject({ image: 'ubuntu:24.04', imageFrom: '.container-use', install: ['make deps'] })
  })

  it('normalises paths lexically', () => {
    expect(lexicalRel('./src//a.ts')).toBe('src/a.ts')
    expect(() => lexicalRel('a/../../b')).toThrow(/escapes/)
    expect(() => lexicalRel('.git/config')).toThrow(/\.git/)
    expect(() => lexicalRel('/etc/passwd')).toThrow()
  })
})

describe('the run tool', () => {
  function session(ws: Workspace, runTimeoutS = 600): Session {
    return new SessionRegistry().open({
      id: 'r1', kind: 'round', repo: {} as RepoRow, check: { categories: ['x'] } as CheckDef, worktree: '/nowhere', ws, head: 'h', allowWrite: false, timeoutS: 1800, runTimeoutS,
    })
  }
  const calls: { command: string; timeoutMs: number }[] = []
  const sandboxed: Workspace = {
    ...new LocalWorkspace('/nowhere'),
    resolve: async () => 'x', git: async () => '', readFile: async () => null, writeFile: async () => undefined, deleteFile: async () => false,
    exec: async (command, o) => (calls.push({ command, timeoutMs: o.timeoutMs }), { code: 3, output: 'boom', timedOut: false }),
  }

  it('is offered and accepted only when the workspace can run code', async () => {
    const local = session(new LocalWorkspace(tmp()))
    expect(toolSpecs(local).map((t) => t.name)).not.toContain('run')
    await expect(execTool(local, 'run', { command: 'id' })).rejects.toThrow(/needs the sandbox/)
    const sb = session(sandboxed)
    expect(toolSpecs(sb).map((t) => t.name)).toContain('run')
    expect(await execTool(sb, 'run', { command: 'npm test' })).toBe('exit 3\nboom')
  })

  it('never runs past its cap', async () => {
    calls.length = 0
    await execTool(session(sandboxed, 60), 'run', { command: 'sleep 1000', timeout_s: 3600 })
    expect(calls[0]!.timeoutMs).toBe(60_000)
  })
})

/**
 * Against a real Docker: `LAMPLIGHTER_TEST_DOCKER=unix:///var/run/docker.sock npm test`. Slow on
 * first run (it pulls the base image and mise, then mise installs Node).
 */
const DOCKER = process.env.LAMPLIGHTER_TEST_DOCKER
describe.skipIf(!DOCKER)('a real sandbox', () => {
  const rt = new SandboxRuntime(DOCKER ?? '')
  let ws: SandboxWorkspace | undefined
  afterAll(async () => ws?.dispose())

  function repo(): { root: string; head: string } {
    const root = write(tmp(), {
      'package.json': JSON.stringify({ name: 'fx', version: '1.0.0', scripts: { test: 'node --test' } }),
      '.nvmrc': '22\n',
      'test/a.test.js': "const t = require('node:test'); const a = require('node:assert'); t('adds', () => a.strictEqual(1 + 1, 2))\n",
      'README.md': '# fx\n',
    })
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root }).toString().trim()
    g('init', '-q', '-b', 'main')
    g('add', '-A')
    g('commit', '-q', '-m', 'one')
    writeFileSync(join(root, 'README.md'), '# fx\n\nTwo.\n')
    g('commit', '-qam', 'two')
    g('remote', 'add', 'origin', 'https://x-access-token:SECRET@example.invalid/fx.git')
    return { root, head: g('rev-parse', 'HEAD') }
  }

  it('clones with history and without a remote, runs tests, and hands back a patch', { timeout: 900_000 }, async () => {
    const { root, head } = repo()
    ws = await openSandbox(rt, cfg, { sessionId: `t${Date.now().toString(36)}`, worktree: root, head })
    expect((await ws.git(['log', '--format=%s'])).trim().split('\n')).toEqual(['two', 'one'])
    expect((await ws.git(['remote'])).trim()).toBe('')
    expect((await ws.readFile('.git/config'))?.toString()).not.toMatch(/SECRET|example\.invalid/)
    expect((await ws.exec('env', { timeoutMs: 10_000, maxBytes: 20_000 })).output).not.toMatch(/SECRET|LAMPLIGHTER_/)
    expect((await ws.exec('id -u', { timeoutMs: 10_000, maxBytes: 1000 })).output.trim()).toBe('10001')

    const t = await ws.exec('mise install && npm test', { timeoutMs: 600_000, maxBytes: 20_000 })
    expect(t.output).toMatch(/pass 1/)
    expect(t.code).toBe(0)

    await ws.writeFile('src/new.js', 'module.exports = 1\n')
    await ws.exec('mkdir -p node_modules/x && echo junk > node_modules/x/i.js', { timeoutMs: 10_000, maxBytes: 1000 })
    const patch = await ws.exportPatch()
    expect(patch).toMatch(/\+\+\+ b\/src\/new\.js/)
    expect(patch).not.toMatch(/node_modules/)

    await ws.exec('ln -s /etc out && ln -s .git g', { timeoutMs: 10_000, maxBytes: 1000 })
    await expect(ws.resolve('out/passwd')).rejects.toThrow(/escapes/)
    await expect(ws.resolve('g/config')).rejects.toThrow(/\.git/)
    expect(await ws.resolve('src/new.js')).toBe('src/new.js')

    const slow = await ws.exec('sleep 30', { timeoutMs: 2_000, maxBytes: 1000 })
    expect(slow.timedOut).toBe(true)
  })
})
