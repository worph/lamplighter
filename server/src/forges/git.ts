import type { ForgeApi, ForgeHealth, ForgeRow, RemoteRepo } from './types.js'
import { basicAuthHeader } from './http.js'

/**
 * A bare git remote: SSH, HTTPS or a local path. There is no REST side — no visibility to read
 * (the repo row says, default private), no PRs (delivery `pr` falls back to `branch`).
 * `base_url` is a prefix the repo name is appended to; a repo may also carry a full remote URL.
 */
export class PlainGitForge implements ForgeApi {
  readonly kind = 'git' as const

  constructor(private readonly row: ForgeRow) {}

  async probe(): Promise<ForgeHealth> {
    return { ok: true, detail: this.row.base_url ? `remotes under ${this.row.base_url}` : 'remotes given per repo' }
  }

  gitAuth(): Record<string, string> {
    return this.row.token ? basicAuthHeader(this.row.username || 'git', this.row.token) : {}
  }

  cloneUrl(owner: string, name: string): string {
    const base = (this.row.base_url ?? '').replace(/\/$/, '')
    return owner ? `${base}/${owner}/${name}.git` : `${base}/${name}.git`
  }

  async repoInfo(owner: string, name: string): Promise<RemoteRepo> {
    return { owner, name, defaultBranch: 'main', visibility: 'private', cloneUrl: this.cloneUrl(owner, name) }
  }

  async listRepos(): Promise<RemoteRepo[]> {
    throw new Error('a bare git forge cannot list repositories — add them one by one')
  }
}
