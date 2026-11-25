import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { git } from '../forges/gitcli.js'

/**
 * Where a session's tools act. `LocalWorkspace` is a worktree on Lamplighter's own disk (v1: no
 * repository code ever runs); the sandbox's workspace is a container (sandbox/workspace.ts), which
 * adds `exec`. Paths in and out are repo-relative with forward slashes.
 */
export interface Workspace {
  /** Validate a repo-relative path and return it normalised; throws ToolInputError on an escape or .git. */
  resolve(p: unknown): Promise<string>
  /** `git <args>` at the repository root. A non-zero exit rejects with `code` set, like gitcli's `git`. */
  git(args: string[]): Promise<string>
  /** The file's bytes, or null when there is no regular file there. */
  readFile(rel: string): Promise<Buffer | null>
  writeFile(rel: string, content: string): Promise<void>
  /** False when there was nothing to delete. */
  deleteFile(rel: string): Promise<boolean>
  /** Run a shell command at the repository root: only a workspace that may run repository code has it. */
  exec?(command: string, opts: { timeoutMs: number; maxBytes: number }): Promise<{ code: number; output: string; timedOut: boolean }>
}

export class ToolInputError extends Error {}

/** Resolve a repo-relative path inside the worktree, refusing escapes (lexical and via symlinks) and the git metadata. */
export function checkRel(worktree: string, p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new ToolInputError('path is required')
  const clean = p.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isAbsolute(clean)) throw new ToolInputError('path must be relative to the repository root')
  const abs = resolve(worktree, clean)
  const rel = relative(worktree, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ToolInputError(`path escapes the repository: ${p}`)
  if (rel.split(sep)[0] === '.git') throw new ToolInputError('the .git directory is not part of the workspace')

  // Symlinks: resolve the deepest existing component (a dangling symlink counts as existing and
  // fails to resolve) and require the real location to stay inside the real worktree.
  let existing = abs
  for (;;) {
    try {
      lstatSync(existing)
      break
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new ToolInputError(`cannot access path: ${p}`)
      const parent = dirname(existing)
      if (parent === existing) throw new ToolInputError(`path escapes the repository: ${p}`)
      existing = parent
    }
  }
  let realExisting: string
  let realRoot: string
  try {
    realExisting = realpathSync(existing)
    realRoot = realpathSync(worktree)
  } catch {
    throw new ToolInputError(`path escapes the repository: ${p}`)
  }
  const realRel = relative(realRoot, realExisting)
  if (realRel.startsWith('..') || isAbsolute(realRel)) throw new ToolInputError(`path escapes the repository: ${p}`)
  if (realRel.split(sep)[0] === '.git') throw new ToolInputError('the .git directory is not part of the workspace')
  return abs
}

export class LocalWorkspace implements Workspace {
  constructor(readonly root: string) {}

  async resolve(p: unknown): Promise<string> {
    return relative(this.root, checkRel(this.root, p)).split(sep).join('/')
  }

  git(args: string[]): Promise<string> {
    return git(args, { cwd: this.root })
  }

  async readFile(rel: string): Promise<Buffer | null> {
    const abs = resolve(this.root, rel)
    if (!existsSync(abs) || !statSync(abs).isFile()) return null
    return readFileSync(abs)
  }

  async writeFile(rel: string, content: string): Promise<void> {
    const abs = resolve(this.root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  async deleteFile(rel: string): Promise<boolean> {
    const abs = resolve(this.root, rel)
    if (!existsSync(abs)) return false
    rmSync(abs)
    return true
  }
}
