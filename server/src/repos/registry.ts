import type { Db } from '../db/index.js'
import { now } from '../db/index.js'
import { forgeApi, forgeRow } from '../forges/index.js'
import { asAnyCredential } from '../forges/auth.js'

export interface RepoRow {
  key: string
  forge_id: string
  group_id: string
  owner: string
  name: string
  remote_url: string
  line: string
  visibility: 'public' | 'private'
  policy: string
  settings_json: string
  /** Pinned credential; null lets the group's pin, then auto, choose. */
  credential_id: string | null
  last_fetch_at: string | null
  last_head: string | null
  fetch_error: string | null
  created_at: string
}

export interface GroupRow {
  id: string
  name: string
  policy: string
  settings_json: string
  /** Pinned credential for the group's repos on that credential's forge. */
  credential_id: string | null
}

/** `<forge>~<owner>/<name>`. `~` survives encodeURIComponent, so a key is one URL segment. */
export function repoKey(forgeId: string, owner: string, name: string): string {
  return owner ? `${forgeId}~${owner}/${name}` : `${forgeId}~${name}`
}

export function getRepo(db: Db, key: string): RepoRow {
  const row = db.prepare('SELECT * FROM repos WHERE key = ?').get(key) as RepoRow | undefined
  if (!row) throw new Error(`no repo "${key}"`)
  return row
}

export function listRepos(db: Db): RepoRow[] {
  return db.prepare('SELECT * FROM repos ORDER BY key').all() as RepoRow[]
}

export function getGroup(db: Db, id: string): GroupRow {
  const row = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as GroupRow | undefined
  if (!row) throw new Error(`no group "${id}"`)
  return row
}

export function listGroups(db: Db): GroupRow[] {
  return db.prepare('SELECT * FROM groups ORDER BY name').all() as GroupRow[]
}

export function ensureDefaultGroup(db: Db, defaultPolicy: string): void {
  db.prepare("INSERT OR IGNORE INTO groups (id, name, policy) VALUES ('default', 'default', ?)").run(defaultPolicy)
}

export interface AddRepoInput {
  forge_id: string
  owner?: string
  name: string
  remote_url?: string
  line?: string
  group_id?: string
  visibility?: 'public' | 'private'
}

/** Visibility and line come from the forge when it can say; the input wins when given. */
export async function addRepo(db: Db, input: AddRepoInput): Promise<RepoRow> {
  const forge = forgeRow(db, input.forge_id)
  const api = forgeApi(forge)
  const owner = input.owner ?? ''
  let line = input.line
  let visibility = input.visibility
  let remote = input.remote_url
  if (forge.kind !== 'git') {
    // Not enrolled yet, so no credential is chosen: ask as whichever one can see it.
    const info = await asAnyCredential(db, forge.id, (a) => a.repoInfo(owner, input.name))
    line ??= info.defaultBranch
    visibility ??= info.visibility
    remote ??= api.cloneUrl(owner, input.name)
  }
  const key = repoKey(forge.id, owner, input.name)
  const groupId = input.group_id ?? 'default'
  getGroup(db, groupId)
  db.prepare(
    `INSERT INTO repos (key, forge_id, group_id, owner, name, remote_url, line, visibility, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(key, forge.id, groupId, owner, input.name, remote ?? api.cloneUrl(owner, input.name), line ?? 'main', visibility ?? 'private', now())
  return getRepo(db, key)
}

export function parseSettings(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}
