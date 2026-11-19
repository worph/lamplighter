import type { CompleteRequest, Driver, SessionRequest, SessionResult, Usage } from './types.js'
import { InferenceError } from './types.js'
import { postJson } from './http.js'

/**
 * Any OpenAI-compatible `/chat/completions` endpoint with function calling (OpenAI, OpenRouter,
 * Ollama, vLLM, LiteLLM, Anthropic's compatibility layer…). Lamplighter owns the loop: it offers
 * the session's tools, executes each call, feeds the result back, and stops when the model calls
 * `finish`/`cannot`, answers without a tool call, or runs out of rounds.
 */

export interface OpenAiOptions {
  url: string
  model: string
  bearer?: string
  maxRounds: number
  fetchImpl?: typeof postJson
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

interface Completion {
  choices?: { message: Message; finish_reason?: string }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message: string }
}

const RESULT_CHARS = 20_000

export function completionsUrl(base: string): string {
  const b = base.replace(/\/$/, '')
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`
}

export function createOpenAiDriver(opts: OpenAiOptions): Driver {
  const post = opts.fetchImpl ?? postJson
  const url = completionsUrl(opts.url)
  const headers = opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : undefined

  async function call(body: Record<string, unknown>, timeoutMs: number): Promise<Completion> {
    let res: { status: number; text: string }
    try {
      res = await post(url, { model: opts.model, ...body }, { headers, timeoutMs })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new InferenceError('completion timed out', 'timeout')
      throw new InferenceError(`cannot reach ${url}: ${(err as Error).message}`, 'missing')
    }
    if (res.status === 401 || res.status === 403) throw new InferenceError(`backend refused credentials (${res.status})`, 'auth')
    if (res.status === 404) throw new InferenceError(`no completions endpoint at ${url}`, 'missing')
    if (res.status === 429) throw new InferenceError('rate limited (429)', 'busy')
    let parsed: Completion
    try {
      parsed = JSON.parse(res.text) as Completion
    } catch {
      throw new InferenceError(`unreadable answer (${res.status}): ${res.text.slice(0, 200)}`, 'error')
    }
    if (res.status >= 400 || parsed.error) throw new InferenceError(parsed.error?.message ?? `HTTP ${res.status}`, 'error')
    return parsed
  }

  return {
    name: 'openai',
    mode: 'tool-calling',
    async runSession(req: SessionRequest): Promise<SessionResult> {
      const started = Date.now()
      const deadline = started + req.timeoutS * 1000
      const usage: Usage = { wall_ms: 0, tokens_in: 0, tokens_out: 0 }
      const tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      const messages: Message[] = [{ role: 'user', content: req.prompt }]
      let lastText = ''
      for (let round = 0; round < opts.maxRounds && !req.isDone(); round++) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new InferenceError(`session exceeded ${req.timeoutS}s`, 'timeout')
        const c = await call({ messages, tools, tool_choice: 'auto' }, remaining)
        usage.tokens_in! += c.usage?.prompt_tokens ?? 0
        usage.tokens_out! += c.usage?.completion_tokens ?? 0
        const msg = c.choices?.[0]?.message
        if (!msg) throw new InferenceError('answer had no choices', 'error')
        messages.push({ role: 'assistant', content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) })
        if (msg.content) lastText = msg.content
        if (!msg.tool_calls?.length) {
          // A model that stops calling tools before finishing gets one nudge, then the session ends.
          if (round > 0 && !req.isDone()) {
            messages.push({ role: 'user', content: 'Call `finish` (or `cannot`) to end the session.' })
            continue
          }
          break
        }
        for (const tc of msg.tool_calls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>
          } catch {
            /* the tool reports the bad arguments */
          }
          let out: string
          try {
            out = await req.exec(tc.function.name, args)
          } catch (err) {
            out = `error: ${(err as Error).message}`
          }
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out.slice(0, RESULT_CHARS) })
        }
      }
      usage.wall_ms = Date.now() - started
      return { text: lastText, usage }
    },
    async complete(req: CompleteRequest): Promise<SessionResult> {
      const started = Date.now()
      const c = await call({ messages: [{ role: 'user', content: req.prompt }] }, (req.timeoutS ?? 180) * 1000)
      return {
        text: c.choices?.[0]?.message?.content ?? '',
        usage: { wall_ms: Date.now() - started, tokens_in: c.usage?.prompt_tokens, tokens_out: c.usage?.completion_tokens },
      }
    },
    async probe() {
      try {
        const r = await this.complete({ prompt: 'Reply with the single word: ok', timeoutS: 60 })
        return { ok: true, detail: `answered: ${r.text.slice(0, 40)}` }
      } catch (err) {
        return { ok: false, detail: (err as Error).message }
      }
    },
  }
}
