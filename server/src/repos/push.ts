import type { RepoRow } from './registry.js'
import type { Mirrors } from './mirror.js'
import { git } from '../forges/gitcli.js'
import type { OwnBranch } from '../forges/refs.js'

/**
 * Every ref Lamplighter moves on a remote is moved here, and only three ways exist:
 * create/update one of its own branches, delete one of its own branches, and fast-forward the
 * tracked line. There is no forced update anywhere in this file and a test keeps it that way —
 * a refspec without the leading plus is refused by the remote unless it is a fast-forward.
 */

export async function pushOwnBranch(m: Mirrors, repo: RepoRow, branch: OwnBranch, sha: string): Promise<void> {
  await git(['push', '--quiet', 'origin', `${sha}:refs/heads/${branch}`], { gitDir: m.gitDir(repo), config: m.auth(repo), timeoutMs: 300_000 })
}

export async function deleteOwnBranch(m: Mirrors, repo: RepoRow, branch: OwnBranch): Promise<void> {
  await git(['push', '--quiet', 'origin', '--delete', `refs/heads/${branch}`], { gitDir: m.gitDir(repo), config: m.auth(repo), timeoutMs: 120_000 })
}

export class LineMovedError extends Error {
  constructor(readonly head: string) {
    super(`the line moved (now ${head.slice(0, 8)}); the change is no longer a fast-forward`)
    this.name = 'LineMovedError'
  }
}

/** Fast-forward `repo.line` to `sha`, which must descend from the line's current head. */
export async function fastForwardLine(m: Mirrors, repo: RepoRow, sha: string): Promise<void> {
  const head = await m.fetch(repo)
  if (!(await m.isAncestor(repo, head, sha))) throw new LineMovedError(head)
  await git(['push', '--quiet', 'origin', `${sha}:refs/heads/${repo.line}`], { gitDir: m.gitDir(repo), config: m.auth(repo), timeoutMs: 300_000 })
}
