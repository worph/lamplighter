import type { Db } from '../db/index.js'
import { GiteaForge } from './gitea.js'
import { GitHubForge } from './github.js'
import { PlainGitForge } from './git.js'
import type { ForgeApi, ForgeRow } from './types.js'

export function forgeRow(db: Db, id: string): ForgeRow {
  const row = db.prepare('SELECT * FROM forges WHERE id = ?').get(id) as ForgeRow | undefined
  if (!row) throw new Error(`no forge "${id}"`)
  return row
}

export function forgeApi(row: ForgeRow): ForgeApi {
  switch (row.kind) {
    case 'github':
      return new GitHubForge(row)
    case 'gitea':
      return new GiteaForge(row)
    case 'git':
      return new PlainGitForge(row)
  }
}

export function listForges(db: Db): ForgeRow[] {
  return db.prepare('SELECT * FROM forges ORDER BY created_at').all() as ForgeRow[]
}
