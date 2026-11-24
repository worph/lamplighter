import type { CompleteRequest, Driver, SessionRequest, SessionResult, ToolSpec, Usage } from './types.js'
import { InferenceError } from './types.js'
import { postJson } from './http.js'
import { completionsUrl } from './openai.js'

/**
 * Any OpenAI-compatible `/chat/completions` endpoint **without** function calling — first of all
 * claude-code-container's OpenAI API, which is text in, text out. Lamplighter owns the loop, as
 * with `openai`, but the tools travel in the prompt: the model answers with a fenced `tool` block
 * of calls, Lamplighter runs them and sends the results back in the next user message. Nothing on
 * the backend needs a route to Lamplighter, and the model needs no tool of its own.
 *
 * Claude Code's API takes a few non-standard body fields (ignored by other endpoints): this
 * driver uses them only to narrow what the CLI may do — `default` permission mode, and its own
 * tools disallowed — so a prompt injected through repository content reaches neither a shell nor
 * the user's other MCP servers, whatever the box's defaults.
 */

export interface TextOptions {
  url: string
  model: string
  bearer?: string
  maxRounds: number
  fetchImpl?: typeof postJson
}

interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface Completion {
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message: string }
}

const RESULT_CHARS = 20_000
const CALLS_PER_TURN = 8
/** The most a claude-code-container request may run (its own cap). */
const MAX_REQUEST_S = 3600
/** The least a standalone request is given, however small the caller's budget. */
const MIN_REQUEST_S = 30
/** Transport slack on top of a standalone request's own timeout. */
const HTTP_SLACK_S = 60
/** The least a request inside a session is given: the session deadline bounds it. */
const SESSION_MIN_REQUEST_S = 1
/** Transport slack on top of an in-session request's own timeout. */
const SESSION_HTTP_SLACK_S = 5
/** How long the probe's one-word request may take. */
const PROBE_TIMEOUT_S = 90

/** Claude Code's own tools: the model works only through the tools Lamplighter describes. */
const BACKEND_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'Task', 'TodoWrite']
const NARROWING = { permission_mode: 'default', allowed_tools: [], disallowed_tools: BACKEND_TOOLS }

export interface ToolCall {
  tool: string
  args: Record<string, unknown>
}

/**
 * The calls in an answer's last ```tool block (```json is accepted too): an array of
 * `{tool, args}`, or one such object. `undefined` when the answer has no block; a block that is
 * not valid JSON is reported back to the model as a result rather than ending the session.
 */
export function parseToolCalls(text: string): ToolCall[] | { error: string } | undefined {
  const blocks = [...text.matchAll(/```(?:tool|json)\s*\n([\s\S]*?)```/g)].map((m) => m[1]!)
  const block = blocks.at(-1)
  if (block === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch (err) {
    return { error: `the tool block is not valid JSON: ${(err as Error).message}` }
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const calls: ToolCall[] = []
  for (const c of list) {
    const o = c as { tool?: unknown; name?: unknown; args?: unknown; arguments?: unknown }
    const tool = typeof o?.tool === 'string' ? o.tool : typeof o?.name === 'string' ? o.name : undefined
    if (!tool) return { error: 'each call needs a "tool" name' }
    const args = (o.args ?? o.arguments ?? {}) as Record<string, unknown>
    calls.push({ tool, args: typeof args === 'object' && args ? args : {} })
  }
  return calls
}

export function toolProtocol(tools: ToolSpec[]): string {
  return [
    '## How you work in this session',
    '',
    'You have no tools of your own here and no copy of the repository: it lives in Lamplighter,',
    'which runs the tools below for you. To call them, end your answer with one fenced block',
    `tagged \`tool\` holding a JSON array of up to ${CALLS_PER_TURN} calls:`,
    '',
    '```tool',
    '[{"tool": "read_file", "args": {"path": "README.md"}}, {"tool": "grep", "args": {"pattern": "TODO"}}]',
    '```',
    '',
    'Lamplighter runs them in order and replies with each result in a <result> element. Then',
    'continue. Batch independent calls in one block; write nothing after the block.',
    '',
    'Tools (arguments are JSON schema):',
    ...tools.map((t) => `- \`${t.name}\` — ${t.description}\n  args: \`${JSON.stringify(t.parameters)}\``),
    '',
    'The session ends when you call `finish` (or `cannot`). Call exactly one of them, last, on its own.',
  ].join('\n')
}

function results(rows: { tool: string; out: string }[]): string {
  return rows.map((r, i) => `<result n="${i + 1}" tool="${r.tool}">\n${r.out}\n</result>`).join('\n\n')
}

export function createTextDriver(opts: TextOptions): Driver {
  const post = opts.fetchImpl ?? postJson
  const url = completionsUrl(opts.url)
  const headers = opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : undefined

  /**
   * `inSession`: the request is bound by a session deadline, so it gets no 30s floor and only a
   * short transport grace; standalone requests (complete/probe) keep the floor and a 60s grace.
   */
  async function call(messages: Message[], timeoutMs: number, inSession = false): Promise<{ text: string; c: Completion }> {
    const floorS = inSession ? SESSION_MIN_REQUEST_S : MIN_REQUEST_S
    const graceS = inSession ? SESSION_HTTP_SLACK_S : HTTP_SLACK_S
    const timeout = Math.max(floorS, Math.min(MAX_REQUEST_S, Math.floor(timeoutMs / 1000)))
    let res: { status: number; text: string }
    try {
      res = await post(url, { model: opts.model || undefined, messages, timeout, ...NARROWING }, { headers, timeoutMs: (timeout + graceS) * 1000 })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new InferenceError('completion timed out', 'timeout')
      throw new InferenceError(`cannot reach ${url}: ${(err as Error).message}`, 'missing')
    }
    if (res.status === 401 || res.status === 403) throw new InferenceError(`backend refused credentials (${res.status})`, 'auth')
    if (res.status === 404) throw new InferenceError(`no completions endpoint at ${url}`, 'missing')
    if (res.status === 429 || res.status === 503) throw new InferenceError(`backend busy (${res.status})`, 'busy')
    if (res.status === 504) throw new InferenceError('the backend timed out', 'timeout')
    let c: Completion
    try {
      c = JSON.parse(res.text) as Completion
    } catch {
      throw new InferenceError(`unreadable answer (${res.status}): ${res.text.slice(0, 200)}`, 'error')
    }
    if (res.status >= 400 || c.error) {
      const m = c.error?.message ?? `HTTP ${res.status}`
      throw new InferenceError(m.slice(0, 300), /not logged in|please run \/login|invalid api key|authenticat/i.test(m) ? 'auth' : 'error')
    }
    return { text: c.choices?.[0]?.message?.content ?? '', c }
  }

  return {
    name: 'text',
    mode: 'tool-calling',
    async runSession(req: SessionRequest): Promise<SessionResult> {
      const started = Date.now()
      const deadline = started + req.timeoutS * 1000
      const usage: Usage = { wall_ms: 0, tokens_in: 0, tokens_out: 0 }
      const messages: Message[] = [
        { role: 'system', content: toolProtocol(req.tools) },
        { role: 'user', content: req.prompt },
      ]
      let lastText = ''
      let nudged = false
      for (let round = 0; round < opts.maxRounds && !req.isDone(); round++) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new InferenceError(`session exceeded ${req.timeoutS}s`, 'timeout')
        const { text, c } = await call(messages, remaining, true)
        usage.tokens_in! += c.usage?.prompt_tokens ?? 0
        usage.tokens_out! += c.usage?.completion_tokens ?? 0
        messages.push({ role: 'assistant', content: text })
        const calls = parseToolCalls(text)
        if (!calls) {
          lastText = text
          // A model that stops calling tools before finishing gets one nudge, then the session ends.
          if (nudged) break
          nudged = true
          messages.push({ role: 'user', content: 'End with a ```tool block: call `finish` (or `cannot`) to end the session.' })
          continue
        }
        if ('error' in calls) {
          messages.push({ role: 'user', content: results([{ tool: 'error', out: `${calls.error}. Send the block again.` }]) })
          continue
        }
        const rows: { tool: string; out: string }[] = []
        for (const tc of calls.slice(0, CALLS_PER_TURN)) {
          let out: string
          try {
            out = await req.exec(tc.tool, tc.args)
          } catch (err) {
            out = `error: ${(err as Error).message}`
          }
          rows.push({ tool: tc.tool, out: out.slice(0, RESULT_CHARS) })
          if (req.isDone()) break
        }
        if (calls.length > CALLS_PER_TURN) rows.push({ tool: 'error', out: `only the first ${CALLS_PER_TURN} calls ran; send the rest next.` })
        lastText = text
        messages.push({ role: 'user', content: results(rows) })
      }
      usage.wall_ms = Date.now() - started
      return { text: lastText, usage }
    },
    async complete(req: CompleteRequest): Promise<SessionResult> {
      const started = Date.now()
      const { text, c } = await call([{ role: 'user', content: req.prompt }], (req.timeoutS ?? 180) * 1000)
      return { text, usage: { wall_ms: Date.now() - started, tokens_in: c.usage?.prompt_tokens, tokens_out: c.usage?.completion_tokens } }
    },
    async probe() {
      try {
        const r = await this.complete({ prompt: 'Reply with the single word: ok', timeoutS: PROBE_TIMEOUT_S })
        return { ok: true, detail: `answered: ${r.text.slice(0, 40)}` }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
    },
  }
}
