export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function request<T>(url: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...rest,
    headers: { ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const text = await res.text()
  let body: unknown = undefined
  try {
    body = text ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? ((typeof body === "string" && body) || res.statusText))
  return body as T
}

export type LampState = 'lit' | 'dim' | 'out' | 'unlit' | 'off'
export interface Lamp {
  lamp: LampState
  open: number
  last?: string
  status?: string
}

export interface RepoSummary {
  key: string
  forge_id: string
  group_id: string
  owner: string
  name: string
  line: string
  visibility: 'public' | 'private'
  last_head: string | null
  last_fetch_at: string | null
  fetch_error: string | null
  lamps: Record<string, Lamp>
}

export interface CheckSettings {
  enabled: boolean
  delivery: 'report' | 'branch' | 'pr' | 'push'
  auto_submit: boolean
  armed: boolean
  cadence_days: number
}

export interface Finding {
  id: string
  repo_key: string
  check_kind: string
  category: string
  anchor: string
  title: string
  body: string
  severity: 'critical' | 'major' | 'minor'
  sensitive: number
  state: 'open' | 'dismissed' | 'proposed' | 'fixed' | 'gone'
  proposal_id: string | null
  updated_at: string
  dismissal?: { reason: string; by: string; at: string }
}

export interface RoundRow {
  id: string
  repo_key?: string
  check_kind: string
  kind: 'round' | 'author' | 'confirm'
  scope: 'diff' | 'full'
  status: string
  summary: string | null
  error: string | null
  report?: string | null
  trigger: string
  base_sha: string | null
  head_sha: string
  proposal_id: string | null
  started_at: string
  ended_at: string | null
  usage_json?: string | null
}

export interface ProposalRow {
  id: string
  repo_key?: string
  check_kind: string
  state: string
  delivery: string
  branch: string
  base_sha: string
  head_sha: string | null
  summary: string | null
  error: string | null
  submitted_ref: string | null
  patch?: string | null
  sensitive?: number
  validation?: { ok: boolean; round: string; verdict: string; remaining: { title: string; anchor: string; category: string; body: string }[] } | null
  findings?: { id: string; title: string; anchor: string; category: string; severity: string; state: string }[]
  created_at: string
  updated_at: string
}

export interface EventRow {
  id: number
  at: string
  level: 'info' | 'warn' | 'error'
  code: string
  repo_key: string | null
  message: string
}

export interface ActivityItem {
  id: string
  kind: 'proposal-ready' | 'branch-open' | 'pr-open' | 'pushed' | 'held' | 'report' | 'alert'
  repo_key: string | null
  ref_id: string | null
  title: string
  body: string
  url: string | null
  sensitive: number
  state: 'open' | 'resolved'
  resolution: string | null
  reason: string | null
  created_at: string
  resolved_at: string | null
}

export interface QueueRow {
  id: string
  job: string
  repo_key: string
  check_kind: string
  scope: string
  foreground: number
  tier: number
  trigger: string
  state: string
  created_at: string
  started_at: string | null
  waiting?: string
}

export interface Schedule {
  running: QueueRow[]
  queued: QueueRow[]
  budget: { sessions_today: number; sessions_per_day: number; slots: number }
  enabled: boolean
  rotation: boolean
}

export interface RepoDetail extends RepoSummary {
  remote_url: string
  policy: string
  settings: { checks?: Record<string, Partial<CheckSettings>> }
  group: { id: string; name: string; policy: string }
  checks: { kind: string; title: string; scopes: string[]; fixable: boolean; agent: string; settings: CheckSettings }[]
  findings: Finding[]
  rounds: RoundRow[]
  proposals: ProposalRow[]
  events: EventRow[]
}

export interface Forge {
  id: string
  kind: 'github' | 'gitea' | 'git'
  name: string
  base_url: string | null
  username: string | null
  token: string | null
  webhook_secret: string | null
}

export interface SettingsView {
  config: {
    public_url: string
    inference: { driver: 'claude-code' | 'openai'; url: string; tool: string; via: 'beacon' | 'direct'; model: string; workdir: string; timeout_s: number; max_tool_rounds: number }
    identity: { name: string; email: string }
    schedule: { enabled: boolean; rotation: boolean; tick_s: number; poll_min: number; debounce_min: number; slots: number; sessions_per_day: number; deliveries_per_day: number; open_items_per_repo: number }
    checks: Record<string, Partial<CheckSettings>>
  }
  inference_bearer: string | null
  admin_mcp_token: string | null
  forges: Forge[]
  groups: { id: string; name: string; policy: string }[]
  checks: { kind: string; title: string; revision: number; scopes: string[]; agent: string; fixable: boolean; sensitive: string; defaults: CheckSettings; settings: CheckSettings }[]
  check_errors: string[]
  schedule: Schedule
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool: string | null
  pending: string | null
  at: string
}

export const api = {
  overview: () => request<{ repos: number; open_findings: number; inbox: number; schedule: Schedule; inference: { driver: string; url: string }; check_errors: string[] }>('/api/v1/overview'),
  repos: () => request<RepoSummary[]>('/api/v1/repos'),
  repo: (key: string) => request<RepoDetail>(`/api/v1/repos/${encodeURIComponent(key)}`),
  addRepo: (b: Record<string, unknown>) => request<RepoSummary>('/api/v1/repos', { method: 'POST', json: b }),
  patchRepo: (key: string, b: Record<string, unknown>) => request(`/api/v1/repos/${encodeURIComponent(key)}`, { method: 'PATCH', json: b }),
  deleteRepo: (key: string) => request(`/api/v1/repos/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  requestRound: (key: string, check: string, scope: 'full' | 'diff' = 'full') => request(`/api/v1/repos/${encodeURIComponent(key)}/rounds`, { method: 'POST', json: { check, scope } }),
  requestFix: (key: string, check: string) => request<{ result: string }>(`/api/v1/repos/${encodeURIComponent(key)}/fix`, { method: 'POST', json: { check } }),
  fetchRepo: (key: string) => request(`/api/v1/repos/${encodeURIComponent(key)}/fetch`, { method: 'POST' }),
  setRepoCheck: (key: string, check: string, s: Partial<CheckSettings> | null) => request(`/api/v1/repos/${encodeURIComponent(key)}/checks/${check}`, { method: 'PUT', json: s }),
  dismiss: (id: string, reason: string) => request(`/api/v1/findings/${id}/dismiss`, { method: 'POST', json: { reason } }),
  reopen: (id: string) => request(`/api/v1/findings/${id}/reopen`, { method: 'POST' }),
  round: (id: string) => request<RoundRow>(`/api/v1/rounds/${id}`),
  proposal: (id: string) => request<ProposalRow>(`/api/v1/proposals/${id}`),
  approve: (id: string) => request(`/api/v1/proposals/${id}/approve`, { method: 'POST' }),
  reject: (id: string, reason: string) => request(`/api/v1/proposals/${id}/reject`, { method: 'POST', json: { reason } }),
  merge: (id: string) => request(`/api/v1/proposals/${id}/merge`, { method: 'POST' }),
  revert: (id: string) => request(`/api/v1/proposals/${id}/revert`, { method: 'POST' }),
  activity: (state?: 'open' | 'resolved') => request<{ items: ActivityItem[]; events: EventRow[] }>(`/api/v1/activity${state ? `?state=${state}` : ''}`),
  resolveItem: (id: string, reason?: string) => request(`/api/v1/activity/${id}/resolve`, { method: 'POST', json: { reason } }),
  settings: () => request<SettingsView>('/api/v1/settings'),
  putInference: (b: Partial<SettingsView['config']['inference']>) => request('/api/v1/settings/inference', { method: 'PUT', json: b }),
  putBearer: (value: string | null) => request('/api/v1/settings/inference/bearer', { method: 'PUT', json: { value } }),
  testInference: () => request<{ ok: boolean; detail: string }>('/api/v1/settings/inference/test', { method: 'POST' }),
  putSchedule: (b: Partial<SettingsView['config']['schedule']>) => request('/api/v1/settings/schedule', { method: 'PUT', json: b }),
  putGeneral: (b: { public_url?: string; identity?: Partial<SettingsView['config']['identity']> }) => request('/api/v1/settings/general', { method: 'PUT', json: b }),
  putCheck: (check: string, s: Partial<CheckSettings>) => request(`/api/v1/settings/checks/${check}`, { method: 'PUT', json: s }),
  reloadChecks: () => request<{ checks: string[]; errors: string[] }>('/api/v1/settings/checks/reload', { method: 'POST' }),
  mcpToken: () => request<{ token: string }>('/api/v1/settings/mcp-token'),
  rotateMcpToken: () => request<{ token: string }>('/api/v1/settings/mcp-token/rotate', { method: 'POST' }),
  addForge: (b: Record<string, unknown>) => request('/api/v1/forges', { method: 'POST', json: b }),
  patchForge: (id: string, b: Record<string, unknown>) => request(`/api/v1/forges/${id}`, { method: 'PATCH', json: b }),
  deleteForge: (id: string) => request(`/api/v1/forges/${id}`, { method: 'DELETE' }),
  probeForge: (id: string) => request<{ ok: boolean; detail: string }>(`/api/v1/forges/${id}/probe`, { method: 'POST' }),
  discover: (id: string, owner: string) => request<{ owner: string; name: string; defaultBranch: string; visibility: string; enrolled: boolean }[]>(`/api/v1/forges/${id}/discover?owner=${encodeURIComponent(owner)}`),
  addGroup: (b: { id: string; name: string }) => request('/api/v1/groups', { method: 'POST', json: b }),
  patchGroup: (id: string, b: { policy?: string; name?: string }) => request(`/api/v1/groups/${id}`, { method: 'PATCH', json: b }),
  schedule: () => request<Schedule>('/api/v1/schedule'),
  cancelJob: (id: string) => request(`/api/v1/queue/${id}`, { method: 'DELETE' }),
  chat: () => request<{ messages: ChatMessage[] }>('/api/v1/chat'),
  sendChat: (message: string) => request<{ messages: ChatMessage[] }>('/api/v1/chat', { method: 'POST', json: { message } }),
  confirmChat: (id: number, typed: string) => request<{ messages: ChatMessage[] }>('/api/v1/chat/confirm', { method: 'POST', json: { id, typed } }),
  newChat: () => request('/api/v1/chat', { method: 'DELETE' }),
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never'
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
