import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Db } from '../db/index.js'
import { now } from '../db/index.js'
import { apiFor } from '../forges/auth.js'
import { git } from '../forges/gitcli.js'
import { TRAILER_ROUND } from '../forges/refs.js'
import type { RepoRow } from './registry.js'

/**
 * One bare clone per repo under `<data>/repos/`, fetched into `refs/remotes/origin/*` so a fetch
 * never touches Lamplighter's own local branches. Sessions get a detached worktree under
 * `<data>/work/<session>` and nothing else — the model never sees the mirror.
 *
 * Every operation on one mirror runs one at a time: two rounds of the same repo start together
 * (each fetches first), and two gits writing the same `config` or ref fail on its lock file.
 */
export class Mirrors {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(private readonly db: Db, private readonly dataDir: string) {
    mkdirSync(join(dataDir, 'repos'), { recursive: true })
    mkdirSync(join(dataDir, 'work'), { recursive: true })
  }

  gitDir(repo: RepoRow): string {
    return join(this.dataDir, 'repos', `${repo.key.replace(/[^A-Za-z0-9._-]/g, '_')}.git`)
  }

  auth(repo: RepoRow): Record<string, string> {
    return apiFor(this.db, repo).gitAuth()
  }

  /** Run `fn` after every earlier operation on this repo's mirror has settled. */
  private serial<T>(repo: RepoRow, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(repo.key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    this.locks.set(repo.key, tail)
    void tail.then(() => { if (this.locks.get(repo.key) === tail) this.locks.delete(repo.key) })
    return next
  }

  ensure(repo: RepoRow): Promise<string> {
    return this.serial(repo, () => this.ensureNow(repo))
  }

  private async ensureNow(repo: RepoRow): Promise<string> {
    const dir = this.gitDir(repo)
    if (!existsSync(join(dir, 'HEAD'))) {
      mkdirSync(dir, { recursive: true })
      await git(['init', '--bare', '--quiet'], { gitDir: dir })
      await git(['remote', 'add', 'origin', repo.remote_url], { gitDir: dir })
      await git(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'], { gitDir: dir })
    } else {
      const url = (await git(['remote', 'get-url', 'origin'], { gitDir: dir }).catch(() => '')).trim()
      if (url !== repo.remote_url) await git(['remote', 'set-url', 'origin', repo.remote_url], { gitDir: dir })
    }
    return dir
  }

  /** Fetch and return the line's head, recording the attempt on the row. */
  fetch(repo: RepoRow): Promise<string> {
    return this.serial(repo, () => this.fetchNow(repo))
  }

  private async fetchNow(repo: RepoRow): Promise<string> {
    try {
      const dir = await this.ensureNow(repo)
      await git(['fetch', '--prune', '--quiet', 'origin'], { gitDir: dir, config: this.auth(repo), timeoutMs: 300_000 })
      const head = (await git(['rev-parse', `refs/remotes/origin/${repo.line}`], { gitDir: dir })).trim()
      this.db.prepare('UPDATE repos SET last_fetch_at = ?, fetch_error = NULL WHERE key = ?').run(now(), repo.key)
      return head
    } catch (err) {
      this.db.prepare('UPDATE repos SET last_fetch_at = ?, fetch_error = ? WHERE key = ?').run(now(), (err as Error).message, repo.key)
      throw err
    }
  }

  addWorktree(repo: RepoRow, sessionId: string, sha: string): Promise<string> {
    return this.serial(repo, async () => {
      const dir = await this.ensureNow(repo)
      const path = join(this.dataDir, 'work', sessionId)
      await git(['worktree', 'add', '--detach', '--quiet', path, sha], { gitDir: dir })
      return path
    })
  }

  removeWorktree(repo: RepoRow, path: string): Promise<void> {
    return this.serial(repo, async () => {
      const dir = this.gitDir(repo)
      await git(['worktree', 'remove', '--force', path], { gitDir: dir }).catch(() => undefined)
      if (existsSync(path)) rmSync(path, { recursive: true, force: true })
      await git(['worktree', 'prune'], { gitDir: dir }).catch(() => undefined)
    })
  }

  /** Commits in `base..head` that Lamplighter did not author — the loop guard (invariant 4). */
  async foreignCommits(repo: RepoRow, base: string | null, head: string): Promise<string[]> {
    const dir = this.gitDir(repo)
    const range = base ? `${base}..${head}` : head
    const out = await git(['log', '--format=%H%x1f%B%x1e', range, '-n', '500'], { gitDir: dir })
    return out
      .split('\x1e')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.split('\x1f') as [string, string])
      .filter(([, body]) => !body.includes(`${TRAILER_ROUND}:`))
      .map(([sha]) => sha)
  }

  async isAncestor(repo: RepoRow, a: string, b: string): Promise<boolean> {
    try {
      await git(['merge-base', '--is-ancestor', a, b], { gitDir: this.gitDir(repo) })
      return true
    } catch {
      return false
    }
  }
}
