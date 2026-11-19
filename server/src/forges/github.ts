import type { ForgeApi, ForgeHealth, ForgeRow, PrRef, RemoteRepo } from './types.js'
import { basicAuthHeader, jsonRequest } from './http.js'

interface GhRepo {
  name: string
  owner: { login: string }
  default_branch: string
  private: boolean
  visibility?: string
  clone_url: string
  archived?: boolean
}

export const LABEL = 'lamplighter'

/** GitHub over REST with a fine-grained token. Mirrors Touchstone's GitHubClient shape. */
export class GitHubForge implements ForgeApi {
  readonly kind = 'github' as const
  private readonly api: string

  constructor(private readonly row: ForgeRow, private readonly fetchImpl: typeof fetch = fetch) {
    this.api = (row.base_url || 'https://api.github.com').replace(/\/$/, '')
  }

  private headers(): Record<string, string> {
    return {
      'x-github-api-version': '2022-11-28',
      ...(this.row.token ? { authorization: `Bearer ${this.row.token}` } : {}),
    }
  }

  private req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return jsonRequest<T>(this.fetchImpl, `${this.api}${path}`, { ...init, headers: this.headers() })
  }

  async probe(): Promise<ForgeHealth> {
    if (!this.row.token) return { ok: true, detail: 'anonymous (public repos, report only)' }
    try {
      const me = await this.req<{ login: string }>('/user')
      return { ok: true, detail: `authenticated as ${me.login}` }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  gitAuth(): Record<string, string> {
    return this.row.token ? basicAuthHeader(this.row.username || 'x-access-token', this.row.token) : {}
  }

  cloneUrl(owner: string, name: string): string {
    return `https://github.com/${owner}/${name}.git`
  }

  private toRemote(r: GhRepo): RemoteRepo {
    return {
      owner: r.owner.login,
      name: r.name,
      defaultBranch: r.default_branch,
      visibility: r.private || r.visibility === 'internal' ? 'private' : 'public',
      cloneUrl: r.clone_url,
    }
  }

  async repoInfo(owner: string, name: string): Promise<RemoteRepo> {
    return this.toRemote(await this.req<GhRepo>(`/repos/${owner}/${name}`))
  }

  async listRepos(owner: string): Promise<RemoteRepo[]> {
    const out: RemoteRepo[] = []
    for (let page = 1; page <= 10; page++) {
      let batch: GhRepo[]
      try {
        batch = await this.req<GhRepo[]>(`/orgs/${owner}/repos?per_page=100&page=${page}`)
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err
        batch = await this.req<GhRepo[]>(`/users/${owner}/repos?per_page=100&page=${page}`)
      }
      out.push(...batch.filter((r) => !r.archived).map((r) => this.toRemote(r)))
      if (batch.length < 100) break
    }
    return out
  }

  async openPr(owner: string, name: string, a: { head: string; base: string; title: string; body: string }): Promise<PrRef> {
    const pr = await this.req<{ number: number; html_url: string }>(`/repos/${owner}/${name}/pulls`, {
      method: 'POST',
      body: { head: a.head, base: a.base, title: a.title, body: a.body },
    })
    // A missing label is not worth failing a delivered PR over.
    await this.req(`/repos/${owner}/${name}/issues/${pr.number}/labels`, { method: 'POST', body: { labels: [LABEL] } }).catch(() => undefined)
    return { number: pr.number, url: pr.html_url }
  }

  async prState(owner: string, name: string, number: number): Promise<'open' | 'merged' | 'closed'> {
    const pr = await this.req<{ state: string; merged: boolean }>(`/repos/${owner}/${name}/pulls/${number}`)
    return pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed'
  }
}
