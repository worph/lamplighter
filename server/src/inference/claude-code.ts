import type { CompleteRequest, Driver, SessionRequest, SessionResult, Usage } from './types.js'
import { InferenceError } from './types.js'
import { postJson } from './http.js'

/**
 * claude-code-container's `query_claude`, over MCP — straight at the container (`via: direct`) or
 * through a Beacon aggregator (`via: beacon`, the aggregator's own `call` tool). The only
 * claude-code-specific facts are the tool's argument names; the failure classification follows
 * Touchstone's `runner/agent.ts`.
 */

export interface ClaudeCodeOptions {
  url: string
  tool: string
  via: 'beacon' | 'direct'
  bearer?: string
  workdir?: string
  fetchImpl?: typeof postJson
}

/** curl needs Bash; Read/Grep/Glob are harmless and stop the agent from asking. */
const PERMISSIONS = ['Bash', 'Read', 'Grep', 'Glob']

interface RpcEnvelope {
  result?: { content?: { type: string; text?: string }[]; isError?: boolean; _meta?: { usage?: Record<string, unknown> } }
  error?: { code: number; message: string }
}

/** The last JSON-RPC message in an SSE stream, or the body itself when it is plain JSON. */
export function lastMessage(text: string): RpcEnvelope | undefined {
  const frames = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
  const candidates = frames.length ? frames.reverse() : [text]
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as RpcEnvelope
      if (parsed.result || parsed.error) return parsed
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

const AUTH_RE = /(unauthori[sz]ed|\b401\b|not logged in|invalid api key|please run \/login|authentication)/i
const MISSING_RE = /(unknown tool|unknown server|tool not found|not found: tool)/i
const UNREACHABLE_RE = /(fetch failed|econnrefused|enotfound|getaddrinfo|ehostunreach)/i

export function classify(status: number, text: string): InferenceError | undefined {
  if (status === 401 || status === 403) return new InferenceError(`backend refused credentials (${status})`, 'auth')
  if (status === 404) return new InferenceError('no MCP endpoint at that URL (404)', 'missing')
  if (status === 409) return new InferenceError('backend busy (409)', 'busy')
  if (status >= 500) return new InferenceError(`backend error ${status}: ${text.slice(0, 200)}`, 'error')
  const msg = lastMessage(text)
  if (!msg) return new InferenceError(`unreadable answer: ${text.slice(0, 200)}`, 'error')
  if (msg.error) {
    const m = msg.error.message
    if (msg.error.code === -32001 || AUTH_RE.test(m)) return new InferenceError(m, 'auth')
    if (MISSING_RE.test(m)) return new InferenceError(m, 'missing')
    return new InferenceError(m, 'error')
  }
  if (msg.result?.isError) {
    const m = msg.result.content?.map((c) => c.text ?? '').join('\n') ?? 'tool error'
    if (AUTH_RE.test(m)) return new InferenceError(m.slice(0, 300), 'auth')
    if (MISSING_RE.test(m)) return new InferenceError(m.slice(0, 300), 'missing')
    if (/already in progress|conflict/i.test(m)) return new InferenceError(m.slice(0, 300), 'busy')
    if (/timed? ?out/i.test(m)) return new InferenceError(m.slice(0, 300), 'timeout')
    return new InferenceError(m.slice(0, 300), 'error')
  }
  return undefined
}

function usageOf(msg: RpcEnvelope | undefined, wallMs: number): Usage {
  const u = msg?.result?._meta?.usage as Record<string, number> | undefined
  return {
    wall_ms: wallMs,
    tokens_in: u ? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : undefined,
    tokens_out: u?.output_tokens,
    cost_usd: (u as Record<string, number> | undefined)?.total_cost_usd,
  }
}

/** How an agent with a shell reaches the session's tools. Generic HTTP — nothing MCP-specific. */
export function callbackInstructions(req: SessionRequest): string {
  const lines = req.tools.map((t) => `- \`${t.name}\` — ${t.description}\n  arguments: \`${JSON.stringify(t.parameters.properties ?? {})}\``)
  return [
    '## Your workspace',
    '',
    'You do NOT have the repository on your disk. It lives in Lamplighter and you reach it only',
    'through the HTTP endpoint below, with curl from your Bash tool. Do not clone anything and do',
    'not look for the code on your local filesystem.',
    '',
    'Every call is a POST with a JSON body of the tool arguments, and returns plain text:',
    '',
    '```bash',
    `curl -sS -X POST '${req.callback.url}/<tool>' \\`,
    `  -H 'x-session-token: ${req.callback.token}' -H 'content-type: application/json' \\`,
    `  -d '{"path":"README.md"}'`,
    '```',
    '',
    'For a JSON body with quotes or newlines (write_file content, finding bodies), write it to a',
    'temporary file first with a quoted heredoc and pass it with `--data-binary @file`.',
    '',
    'Tools:',
    ...lines,
    '',
    'The session ends when you call `finish` (or `cannot`). Call exactly one of them, last.',
  ].join('\n')
}

export function createClaudeCodeDriver(opts: ClaudeCodeOptions): Driver {
  const post = opts.fetchImpl ?? postJson
  const headers = opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : undefined

  async function query(prompt: string, timeoutS: number, sessionId?: string): Promise<SessionResult> {
    const args: Record<string, unknown> = {
      prompt,
      timeout: timeoutS,
      permission: PERMISSIONS,
      continueSession: false,
      ...(sessionId ? { sessionId } : {}),
      ...(opts.workdir ? { workdir: opts.workdir } : {}),
    }
    const params =
      opts.via === 'beacon'
        ? { name: 'call', arguments: { tool_name: opts.tool, arguments: { ...args, __beacon_timeout: timeoutS + 30 } } }
        : { name: opts.tool, arguments: args }
    const started = Date.now()
    let res: { status: number; text: string }
    try {
      res = await post(opts.url, { jsonrpc: '2.0', id: 1, method: 'tools/call', params }, { headers, timeoutMs: (timeoutS + 60) * 1000 })
    } catch (err) {
      const m = (err as Error).message
      if ((err as Error).name === 'TimeoutError') throw new InferenceError(`no answer within ${timeoutS}s`, 'timeout')
      throw new InferenceError(`cannot reach ${opts.url}: ${m}`, UNREACHABLE_RE.test(m) || /fetch failed/i.test(m) ? 'missing' : 'error')
    }
    const failure = classify(res.status, res.text)
    if (failure) throw failure
    const msg = lastMessage(res.text)
    const text = msg?.result?.content?.map((c) => c.text ?? '').join('\n') ?? ''
    // The CLI reports a dead login as an ordinary, short answer rather than an error.
    if (text.length < 400 && /^(failed to authenticate|not logged in|invalid api key|oauth session expired)/i.test(text.trim())) {
      throw new InferenceError(`the backend is not logged in: ${text.trim()}`, 'auth')
    }
    return { text, usage: usageOf(msg, Date.now() - started) }
  }

  return {
    name: 'claude-code',
    mode: 'agentic',
    async runSession(req) {
      return query(`${req.prompt}\n\n${callbackInstructions(req)}`, req.timeoutS, req.sessionId)
    },
    async complete(req: CompleteRequest) {
      return query(req.prompt, req.timeoutS ?? 180)
    },
    async probe() {
      try {
        if (opts.via === 'beacon') {
          const res = await post(
            opts.url,
            { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'tool_doc', arguments: { tool_name: opts.tool } } },
            { headers, timeoutMs: 15_000 },
          )
          const f = classify(res.status, res.text)
          if (f) return { ok: false, detail: f.message }
          const text = lastMessage(res.text)?.result?.content?.[0]?.text ?? ''
          return text.includes(opts.tool) ? { ok: true, detail: `${opts.tool} found on the aggregator` } : { ok: false, detail: `aggregator does not know ${opts.tool}` }
        }
        const res = await post(opts.url, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { headers, timeoutMs: 15_000 })
        const f = classify(res.status, res.text)
        if (f) return { ok: false, detail: f.message }
        return res.text.includes(`"${opts.tool}"`) ? { ok: true, detail: `${opts.tool} offered by the endpoint` } : { ok: false, detail: `endpoint does not offer ${opts.tool}` }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
    },
  }
}
