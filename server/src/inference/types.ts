/**
 * The inference port. Nothing above this file knows which backend answers.
 *
 * - `agentic` drivers (claude-code) run their own tool loop: the session's tools are described in
 *   the prompt as an HTTP endpoint on Lamplighter, and the agent calls them itself.
 * - `tool-calling` drivers are handed the tool schemas, and Lamplighter runs the loop, executing
 *   each call in-process: through function calling (`openai`), or described in the prompt and
 *   answered in a fenced block (`text`, for endpoints with no function calling, such as
 *   Claude Code's OpenAI API).
 *
 * Either way the same tools run against the same worktree, and a session ends when the model calls
 * `finish` or `cannot` (or stops answering).
 */

export interface ToolSpec {
  name: string
  description: string
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>
}

export interface Usage {
  tokens_in?: number
  tokens_out?: number
  cost_usd?: number
  wall_ms: number
}

export interface SessionRequest {
  sessionId: string
  prompt: string
  timeoutS: number
  tools: ToolSpec[]
  exec(name: string, args: Record<string, unknown>): Promise<string>
  /** Where an agentic backend reaches the same tools: POST `${url}/<tool>` with the token header. */
  callback: { url: string; token: string }
  /** Set by the session when `finish`/`cannot` ran — the tool-calling loop stops on it. */
  isDone(): boolean
}

export interface SessionResult {
  text: string
  usage: Usage
}

export interface CompleteRequest {
  prompt: string
  timeoutS?: number
}

export type InferenceFailure = 'auth' | 'missing' | 'busy' | 'timeout' | 'error'

/** A failure of the backend itself, never of the repo under review (invariant 6). */
export class InferenceError extends Error {
  constructor(message: string, readonly kind: InferenceFailure) {
    super(message)
    this.name = 'InferenceError'
  }
}

export interface Driver {
  name: string
  mode: 'agentic' | 'tool-calling'
  runSession(req: SessionRequest): Promise<SessionResult>
  /** Plain text in, text out — used by the chat and by anything that wants a JSON answer. */
  complete(req: CompleteRequest): Promise<SessionResult>
  probe(): Promise<{ ok: boolean; detail: string }>
}
