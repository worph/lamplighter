import picomatch from 'picomatch'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolSpec } from '../inference/types.js'
import { SESSION_SLACK_S, type Session } from '../sessions/session.js'
import { ToolInputError } from '../sessions/workspace.js'

/**
 * The session toolset: the only way a model sees or changes a repository. The same functions
 * serve both inference modes — over HTTP for an agentic backend, in-process for a tool-calling one.
 * They act on the session's Workspace: a local worktree, or the session's sandbox container.
 */

const MAX_READ = 200_000
const MAX_WRITE = 500_000
const MAX_LINES = 400
/** A `run` result is cut to what every driver passes back whole (openai/text cap results at 20 000 chars). */
const MAX_RUN_OUTPUT = 18_000
/** Session time `run` always leaves for the model to write its report. */
const RUN_RESERVE_S = 120

const severity = z.enum(['critical', 'major', 'minor'])

interface ToolDef<S extends z.ZodTypeAny> {
  name: string
  description: string
  schema: S
  write?: boolean
  /** Runs repository code: only in a sandbox session. */
  exec?: boolean
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
      const tracked = await s.ws.git(['ls-files', '-z'])
      const others = await s.ws.git(['ls-files', '-z', '--others', '--exclude-standard'])
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
      const buf = await s.ws.readFile(await s.ws.resolve(path))
      if (!buf) throw new ToolInputError(`no such file: ${path}`)
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
        const out = await s.ws.git(args)
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
      if (path) args.push('--', await s.ws.resolve(path))
      return (await s.ws.git(args)) || '(no commits)'
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
      if (path) args.push('--', await s.ws.resolve(path))
      const out = await s.ws.git(args)
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
      if (!s.check || s.kind === 'author') throw new ToolInputError('this session records no findings')
      if (!s.check.categories.includes(f.category)) {
        throw new ToolInputError(`category must be one of: ${s.check.categories.join(', ')}`)
      }
      if (s.findings.length >= 50) throw new ToolInputError('50 findings is the limit for one session — keep the most important')
      s.findings.push(f)
      return `recorded (${s.findings.length} so far)`
    },
  }),
  def({
    name: 'decide',
    description:
      'Judge one candidate finding: admit (it becomes work), defer (not now: kept, visible, judged again when something changes) or decline (not worth doing here). rationale: one or two sentences a maintainer would accept. precedents: the ids of the past decisions you relied on.',
    schema: z.object({
      finding_id: z.string(),
      decision: z.enum(['admit', 'defer', 'decline']),
      rationale: z.string().min(10).max(800),
      precedents: z.array(z.string()).max(10).default([]),
    }),
    async run(s, d) {
      const brief = s.arbiter
      if (!brief) throw new ToolInputError('only an arbiter session decides')
      const c = brief.candidates.get(d.finding_id)
      if (!c) throw new ToolInputError(`${d.finding_id} is not one of the candidates listed in your instructions`)
      if (brief.decisions.some((x) => x.finding_id === d.finding_id)) throw new ToolInputError(`${d.finding_id} is already decided`)
      if (d.decision === 'decline' && c.sensitive) throw new ToolInputError('a sensitive finding is not declined: defer it, so a person sees it')
      const unknown = d.precedents.filter((p) => !brief.precedents.has(p))
      if (unknown.length) throw new ToolInputError(`not precedents you were shown: ${unknown.join(', ')}`)
      brief.decisions.push(d)
      return `${d.decision} recorded (${brief.decisions.length} of ${brief.candidates.size})`
    },
  }),
  def({
    name: 'write_file',
    description: 'Create or overwrite a file with the full new content. Fixing sessions only.',
    schema: z.object({ path: z.string(), content: z.string() }),
    write: true,
    async run(s, { path, content }) {
      const rel = await s.ws.resolve(path)
      if (content.length > MAX_WRITE) throw new ToolInputError('file too large')
      await s.ws.writeFile(rel, content)
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
      if (!(await s.ws.deleteFile(await s.ws.resolve(path)))) throw new ToolInputError(`no such file: ${path}`)
      s.written.add(path)
      return `deleted ${path}`
    },
  }),
  def({
    name: 'run',
    description:
      'Run a shell command (sh -c) at the repository root inside the sandbox: tests, builds, package managers, `--help`. Toolchains come from mise (`mise install` first if node/python is missing). Returns the exit code and the output, cut in the middle when long.',
    schema: z.object({ command: z.string().min(1).max(4000), timeout_s: z.number().int().min(1).max(3600).optional() }),
    exec: true,
    async run(s, { command, timeout_s }) {
      if (!s.ws.exec) throw new ToolInputError('run needs the sandbox, and this session has none')
      const left = Math.floor((s.expiresAt - Date.now()) / 1000) - SESSION_SLACK_S - RUN_RESERVE_S
      const limit = Math.min(timeout_s ?? s.runTimeoutS, s.runTimeoutS, left)
      if (limit < 1) throw new ToolInputError('not enough session time left to run a command — finish now')
      const r = await s.ws.exec(command, { timeoutMs: limit * 1000, maxBytes: MAX_RUN_OUTPUT })
      const status = r.timedOut ? `timed out after ${limit}s` : `exit ${r.code}`
      return `${status}\n${r.output || '(no output)'}`
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

/** Which tools a session is offered: an arbiter only reads and decides; only a review records findings. */
function offered(s: Session, t: (typeof WORKSPACE_TOOLS)[number]): boolean {
  if (t.write && !s.allowWrite) return false
  if (t.exec && !s.ws.exec) return false
  if (t.name === 'record_finding') return s.kind === 'round' || s.kind === 'confirm'
  if (t.name === 'decide') return s.kind === 'arbiter'
  if (t.name === 'git_diff') return s.kind !== 'arbiter'
  return true
}

export function toolSpecs(s: Session): ToolSpec[] {
  return WORKSPACE_TOOLS.filter((t) => offered(s, t))
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
  if (tool.exec && !s.ws.exec) throw new ToolInputError(`${name} needs the sandbox, and this session has none`)
  if (!offered(s, tool)) throw new ToolInputError(`${name} is not available in this session`)
  if (s.done && name !== 'finish' && name !== 'cannot') throw new ToolInputError('the session has ended')
  const parsed = tool.schema.safeParse(raw ?? {})
  if (!parsed.success) throw new ToolInputError(`bad arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  s.calls++
  return (tool.run as (s: Session, i: unknown) => Promise<string>)(s, parsed.data)
}
