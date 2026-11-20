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
  /** When the token was last set from the Settings page (never the token itself). */
  token_set_at: string | null
  /** The last token check, JSON `ForgeAuth`. */
  auth_json: string | null
}

/** What the token check made of a forge's token (Touchstone's GitHubStatus, per forge). */
export interface ForgeAuth {
  state: 'unconfigured' | 'unknown' | 'ok' | 'failing'
  login?: string
  user_id?: number
  /** One row per monitored repo on this forge: may the token push there? */
  repos?: { repo: string; push: boolean; detail?: string }[]
  problems: string[]
  checked_at?: string
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
  /** The token's account. Throws without a token or when the forge refuses it. */
  whoami?(): Promise<{ login: string; id: number }>
  /** May the token push to this repo? `detail` says why not. */
  canPush?(owner: string, name: string): Promise<{ push: boolean; detail?: string }>
  repoInfo(owner: string, name: string): Promise<RemoteRepo>
  listRepos(owner: string): Promise<RemoteRepo[]>
  openPr?(owner: string, name: string, args: { head: string; base: string; title: string; body: string }): Promise<PrRef>
  prState?(owner: string, name: string, number: number): Promise<'open' | 'merged' | 'closed'>
}
