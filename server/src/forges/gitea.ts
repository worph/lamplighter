import type { ForgeApi, ForgeHealth, ForgeRow, PrRef, RemoteRepo } from './types.js'
import { basicAuthHeader, jsonRequest } from './http.js'

interface GtRepo {
  name: string
  owner: { login: string; username?: string }
  default_branch: string
  private: boolean
  clone_url: string
  archived?: boolean
}

const LABEL = 'lamplighter'
const LABEL_COLOR = '#e6a23c'

/** Gitea's REST API (`/api/v1`). Token auth: `Authorization: token <t>`. */
export class GiteaForge implements ForgeApi {
  readonly kind = 'gitea' as const
  private readonly base: string

  constructor(private readonly row: ForgeRow, private readonly fetchImpl: typeof fetch = fetch) {
    if (!row.base_url) throw new Error('a Gitea forge needs base_url')
    this.base = row.base_url.replace(/\/$/, '')
  }

  private req<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    return jsonRequest<T>(this.fetchImpl, `${this.base}/api/v1${path}`, {
      ...init,
      headers: this.row.token ? { authorization: `token ${this.row.token}` } : {},
    })
  }

  async probe(): Promise<ForgeHealth> {
    try {
      if (!this.row.token) {
        const v = await this.req<{ version: string }>('/version')
        return { ok: true, detail: `anonymous, Gitea ${v.version}` }
      }
      const me = await this.req<{ login: string }>('/user')
      return { ok: true, detail: `authenticated as ${me.login}` }
    } catch (err) {
      return { ok: false, detail: (err as Error).message }
    }
  }

  gitAuth(): Record<string, string> {
    return this.row.token ? basicAuthHeader(this.row.username || 'lamplighter', this.row.token) : {}
  }

  cloneUrl(owner: string, name: string): string {
    return `${this.base}/${owner}/${name}.git`
  }

  private toRemote(r: GtRepo): RemoteRepo {
    return {
      owner: r.owner.login ?? r.owner.username,
      name: r.name,
      defaultBranch: r.default_branch,
      visibility: r.private ? 'private' : 'public',
      cloneUrl: this.cloneUrl(r.owner.login ?? r.owner.username ?? '', r.name),
    }
  }

  async repoInfo(owner: string, name: string): Promise<RemoteRepo> {
    return this.toRemote(await this.req<GtRepo>(`/repos/${owner}/${name}`))
  }

  async listRepos(owner: string): Promise<RemoteRepo[]> {
    const out: RemoteRepo[] = []
    for (let page = 1; page <= 20; page++) {
      let batch: GtRepo[]
      try {
        batch = await this.req<GtRepo[]>(`/orgs/${owner}/repos?limit=50&page=${page}`)
      } catch (err) {
        if ((err as { status?: number }).status !== 404) throw err
        batch = await this.req<GtRepo[]>(`/users/${owner}/repos?limit=50&page=${page}`)
      }
      out.push(...batch.filter((r) => !r.archived).map((r) => this.toRemote(r)))
      if (batch.length < 50) break
    }
    return out
  }

  private async labelId(owner: string, name: string): Promise<number | undefined> {
    const labels = await this.req<{ id: number; name: string }[]>(`/repos/${owner}/${name}/labels?limit=50`)
    const found = labels.find((l) => l.name === LABEL)
    if (found) return found.id
    const made = await this.req<{ id: number }>(`/repos/${owner}/${name}/labels`, {
      method: 'POST',
      body: { name: LABEL, color: LABEL_COLOR, description: 'Opened by Lamplighter' },
    })
    return made.id
  }

  async openPr(owner: string, name: string, a: { head: string; base: string; title: string; body: string }): Promise<PrRef> {
    const label = await this.labelId(owner, name).catch(() => undefined)
    const pr = await this.req<{ number: number; html_url: string }>(`/repos/${owner}/${name}/pulls`, {
      method: 'POST',
      body: { head: a.head, base: a.base, title: a.title, body: a.body, ...(label ? { labels: [label] } : {}) },
    })
    return { number: pr.number, url: pr.html_url }
  }

  async prState(owner: string, name: string, number: number): Promise<'open' | 'merged' | 'closed'> {
    const pr = await this.req<{ state: string; merged: boolean }>(`/repos/${owner}/${name}/pulls/${number}`)
    return pr.merged ? 'merged' : pr.state === 'open' ? 'open' : 'closed'
  }
}
