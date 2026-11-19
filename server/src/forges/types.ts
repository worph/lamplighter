export type ForgeKind = 'github' | 'gitea' | 'git'

export interface ForgeRow {
  id: string
  kind: ForgeKind
  name: string
  base_url: string | null
  username: string | null
  token: string | null
  webhook_secret: string | null
  created_at: string
}

export interface RemoteRepo {
  owner: string
  name: string
  defaultBranch: string
  visibility: 'public' | 'private'
  cloneUrl: string
}

export interface PrRef {
  number: number
  url: string
}

export interface ForgeHealth {
  ok: boolean
  detail: string
}

/**
 * Everything Lamplighter asks of a forge *besides* git itself. Git transport (fetch, push) goes
 * through the git CLI with `gitAuth()`; this is the REST side. `git` forges have no REST side.
 */
export interface ForgeApi {
  kind: ForgeKind
  probe(): Promise<ForgeHealth>
  /** Git `-c` config carrying the credential (http.extraHeader). Empty for anonymous. */
  gitAuth(): Record<string, string>
  cloneUrl(owner: string, name: string): string
  repoInfo(owner: string, name: string): Promise<RemoteRepo>
  listRepos(owner: string): Promise<RemoteRepo[]>
  openPr?(owner: string, name: string, args: { head: string; base: string; title: string; body: string }): Promise<PrRef>
  prState?(owner: string, name: string, number: number): Promise<'open' | 'merged' | 'closed'>
}
