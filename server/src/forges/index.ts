import type { Db } from '../db/index.js'
import { GiteaForge } from './gitea.js'
import { GitHubForge } from './github.js'
import { PlainGitForge } from './git.js'
import type { CredentialRow, ForgeApi, ForgeRow } from './types.js'

export function forgeRow(db: Db, id: string): ForgeRow {
  const row = db.prepare('SELECT * FROM forges WHERE id = ?').get(id) as ForgeRow | undefined
  if (!row) throw new Error(`no forge "${id}"`)
  return row
}

/** The forge's REST side, speaking as `cred` — or anonymously, without one. */
export function forgeApi(row: ForgeRow, cred: CredentialRow | null = null): ForgeApi {
  switch (row.kind) {
    case 'github':
      return new GitHubForge(row, cred)
    case 'gitea':
      return new GiteaForge(row, cred)
    case 'git':
      return new PlainGitForge(row)
  }
}

export function listForges(db: Db): ForgeRow[] {
  return db.prepare('SELECT * FROM forges ORDER BY created_at').all() as ForgeRow[]
}

export function credentialRow(db: Db, id: string): CredentialRow {
  const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as CredentialRow | undefined
  if (!row) throw Object.assign(new Error(`no credential "${id}"`), { statusCode: 404 })
  return row
}

/** A forge's credentials, its default first. */
export function listCredentials(db: Db, forgeId: string): CredentialRow[] {
  return db.prepare('SELECT * FROM credentials WHERE forge_id = ? ORDER BY is_default DESC, created_at, id').all(forgeId) as CredentialRow[]
}
