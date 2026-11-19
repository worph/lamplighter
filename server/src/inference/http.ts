import { Agent } from 'undici'

/**
 * Agent sessions run for many minutes before the first byte comes back. Node's global fetch gives
 * up on headers after 300 s, so every inference call goes through a dispatcher with no header or
 * body timeout; the per-call AbortSignal is the only clock.
 */
export const longDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, keepAliveTimeout: 10_000 })

export async function postJson(
  url: string,
  body: unknown,
  opts: { headers?: Record<string, string>; timeoutMs: number },
): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(opts.headers ?? {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(opts.timeoutMs),
    // @ts-expect-error undici dispatcher is accepted by Node's fetch
    dispatcher: longDispatcher,
  })
  return { status: res.status, text: await res.text() }
}
