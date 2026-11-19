import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import picomatch from 'picomatch'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { git } from '../forges/gitcli.js'
import type { ToolSpec } from '../inference/types.js'
import type { Session } from '../sessions/session.js'

/**
 * The session toolset: the only way a model sees or changes a repository. The same functions
 * serve both inference modes — over HTTP for an agentic backend, in-process for a tool-calling one.
 */

const MAX_READ = 200_000
const MAX_WRITE = 500_000
const MAX_LINES = 400

export class ToolInputError extends Error {}

/** Resolve a repo-relative path inside the worktree, refusing escapes and the git metadata. */
export function checkRel(worktree: string, p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new ToolInputError('path is required')
  const clean = p.replace(/\\/g, '/').replace(/^\.\//, '')
  if (isAbsolute(clean)) throw new ToolInputError('path must be relative to the repository root')
  const abs = resolve(worktree, clean)
  const rel = relative(worktree, abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ToolInputError(`path escapes the repository: ${p}`)
  if (rel.split(sep)[0] === '.git') throw new ToolInputError('the .git directory is not part of the workspace')
  return abs
}

const severity = z.enum(['critical', 'major', 'minor'])

interface ToolDef<S extends z.ZodTypeAny> {
  name: string
  description: string
  schema: S
  write?: boolean
  run(s: Session, input: z.infer<S>): Promise<string>
}

function def<S extends z.ZodTypeAny>(d: ToolDef<S>): ToolDef<S> {
  return d
}

export const WORKSPACE_TOOLS = [
  def({
    name: 'list_files',
    description: 'List files in the repository (tracked and new), optionally filtered by a glob such as "src/**/*.ts".',
    schema: z.object({ glob: z.string().optional() }),
    async run(s, { glob }) {
      const tracked = await git(['ls-files', '-z'], { cwd: s.worktree })
      const others = await git(['ls-files', '-z', '--others', '--exclude-standard'], { cwd: s.worktree })
      let files = [...tracked.split('\0'), ...others.split('\0')].filter(Boolean)
      if (glob) {
        const m = picomatch(glob, { dot: true })
        files = files.filter((f) => m(f))
      }
      files.sort()
      const head = files.slice(0, 3000)
      return head.join('\n') + (files.length > head.length ? `\n… ${files.length - head.length} more (narrow the glob)` : '') || '(no files)'
    },
  }),
  def({
    name: 'read_file',
    description: 'Read a text file. Lines are numbered. Use start_line/end_line for large files.',
    schema: z.object({ path: z.string(), start_line: z.number().int().min(1).optional(), end_line: z.number().int().min(1).optional() }),
    async run(s, { path, start_line, end_line }) {
      const abs = checkRel(s.worktree, path)
      if (!existsSync(abs) || !statSync(abs).isFile()) throw new ToolInputError(`no such file: ${path}`)
      const buf = readFileSync(abs)
      if (buf.subarray(0, 8000).includes(0)) return `(binary file, ${buf.length} bytes)`
      const lines = buf.toString('utf8').split('\n')
      const from = (start_line ?? 1) - 1
      const to = Math.min(end_line ?? lines.length, lines.length)
      let out = ''
      for (let i = from; i < to; i++) {
        const line = `${i + 1}\t${lines[i]}\n`
        if (out.length + line.length > MAX_READ) {
          out += `… truncated at line ${i}; read on with start_line=${i + 1}\n`
          break
        }
        out += line
      }
      return out || '(empty file)'
    },
  }),
  def({
    name: 'grep',
    description: 'Search file contents with an extended regular expression (git grep -E). Returns path:line:text.',
    schema: z.object({ pattern: z.string().min(1), glob: z.string().optional(), ignore_case: z.boolean().optional() }),
    async run(s, { pattern, glob, ignore_case }) {
      const args = ['grep', '-n', '-I', '-E', '--untracked', ...(ignore_case ? ['-i'] : []), '-e', pattern]
      if (glob) args.push('--', glob)
      try {
        const out = await git(args, { cwd: s.worktree })
        const lines = out.split('\n').filter(Boolean)
        return lines.slice(0, MAX_LINES).map((l) => (l.length > 400 ? `${l.slice(0, 400)}…` : l)).join('\n') + (lines.length > MAX_LINES ? `\n… ${lines.length - MAX_LINES} more matches` : '')
      } catch (err) {
        if ((err as { code?: number }).code === 1) return '(no matches)'
        throw err
      }
    },
  }),
  def({
    name: 'git_log',
    description: 'Recent commits (short sha, date, author, subject), optionally for one path.',
    schema: z.object({ limit: z.number().int().min(1).max(200).optional(), path: z.string().optional() }),
    async run(s, { limit, path }) {
      const args = ['log', '--format=%h %ad %an: %s', '--date=short', '-n', String(limit ?? 30), s.head]
      if (path) args.push('--', relative(s.worktree, checkRel(s.worktree, path)))
      return (await git(args, { cwd: s.worktree })) || '(no commits)'
    },
  }),
  def({
    name: 'git_diff',
    description:
      'The diff under review. Without arguments: the session range (a diff-scoped review or a change being validated), or your own uncommitted edits in a fixing session. Optional path narrows it.',
    schema: z.object({ path: z.string().optional(), stat: z.boolean().optional() }),
    async run(s, { path, stat }) {
      const args = ['diff', ...(stat ? ['--stat'] : [])]
      if (s.kind === 'author') args.push('HEAD')
      else if (s.base) args.push(`${s.base}..${s.head}`)
      else return '(this session reviews the whole repository at one commit — there is no diff)'
      if (path) args.push('--', relative(s.worktree, checkRel(s.worktree, path)))
      const out = await git(args, { cwd: s.worktree })
      return out.length > MAX_READ ? `${out.slice(0, MAX_READ)}\n… diff truncated; narrow it with path` : out || '(no changes)'
    },
  }),
  def({
    name: 'record_finding',
    description:
      'Record one problem. anchor = the file path it is about (optionally path#symbol). Pass existing_id when it is the same problem as a finding listed in your instructions.',
    schema: z.object({
      category: z.string(),
      anchor: z.string().min(1),
      title: z.string().min(3).max(200),
      body: z.string().max(8000).default(''),
      severity: severity.default('minor'),
      existing_id: z.string().optional(),
    }),
    async run(s, f) {
      if (s.kind === 'author') throw new ToolInputError('a fixing session records no findings — fix them, then finish')
      if (!s.check.categories.includes(f.category)) {
        throw new ToolInputError(`category must be one of: ${s.check.categories.join(', ')}`)
      }
      if (s.findings.length >= 50) throw new ToolInputError('50 findings is the limit for one session — keep the most important')
      s.findings.push(f)
      return `recorded (${s.findings.length} so far)`
    },
  }),
  def({
    name: 'write_file',
    description: 'Create or overwrite a file with the full new content. Fixing sessions only.',
    schema: z.object({ path: z.string(), content: z.string() }),
    write: true,
    async run(s, { path, content }) {
      const abs = checkRel(s.worktree, path)
      if (content.length > MAX_WRITE) throw new ToolInputError('file too large')
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
      s.written.add(path)
      return `wrote ${path} (${content.length} chars)`
    },
  }),
  def({
    name: 'delete_file',
    description: 'Delete a file. Fixing sessions only.',
    schema: z.object({ path: z.string() }),
    write: true,
    async run(s, { path }) {
      const abs = checkRel(s.worktree, path)
      if (!existsSync(abs)) throw new ToolInputError(`no such file: ${path}`)
      rmSync(abs)
      s.written.add(path)
      return `deleted ${path}`
    },
  }),
  def({
    name: 'finish',
    description:
      'End the session. summary: for a review, the report (markdown); for a fix, the change description — first line is the title.',
    schema: z.object({ summary: z.string().min(1).max(20000) }),
    async run(s, { summary }) {
      s.done = { status: 'finished', text: summary }
      return 'session finished — stop now'
    },
  }),
  def({
    name: 'cannot',
    description: 'End the session without doing the job, saying why (e.g. the fix needs a package manager run).',
    schema: z.object({ reason: z.string().min(1).max(4000) }),
    async run(s, { reason }) {
      s.done = { status: 'cannot', text: reason }
      return 'session ended — stop now'
    },
  }),
]

export function toolSpecs(s: Session): ToolSpec[] {
  return WORKSPACE_TOOLS.filter((t) => !t.write || s.allowWrite)
    .filter((t) => !(t.name === 'record_finding' && s.kind === 'author'))
    .map((t) => {
      const schema = zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as Record<string, unknown>
      delete schema.$schema
      return { name: t.name, description: t.description, parameters: schema }
    })
}

export async function execTool(s: Session, name: string, raw: unknown): Promise<string> {
  const tool = WORKSPACE_TOOLS.find((t) => t.name === name)
  if (!tool) throw new ToolInputError(`unknown tool "${name}"`)
  if (tool.write && !s.allowWrite) throw new ToolInputError(`${name} is not available in a review session`)
  if (s.done && name !== 'finish' && name !== 'cannot') throw new ToolInputError('the session has ended')
  const parsed = tool.schema.safeParse(raw ?? {})
  if (!parsed.success) throw new ToolInputError(`bad arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  s.calls++
  return (tool.run as (s: Session, i: unknown) => Promise<string>)(s, parsed.data)
}
