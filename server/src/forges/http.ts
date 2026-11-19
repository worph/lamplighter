export class ForgeHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'ForgeHttpError'
  }
}

export async function jsonRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const res = await fetchImpl(url, {
    method: init.method ?? 'GET',
    headers: {
      accept: 'application/json',
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 300)
    try {
      msg = (JSON.parse(text) as { message?: string }).message ?? msg
    } catch {
      /* not JSON */
    }
    throw new ForgeHttpError(`${init.method ?? 'GET'} ${new URL(url).pathname} → ${res.status}: ${msg}`, res.status)
  }
  return (text ? JSON.parse(text) : undefined) as T
}

export function basicAuthHeader(user: string, token: string): Record<string, string> {
  return { 'http.extraHeader': `Authorization: Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` }
}
