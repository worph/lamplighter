import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { ago, api, type CheckSettings, type SettingsView } from '../api'
import { Badge, Button, Card, ErrorNote, Field, inputCls } from '../components/ui'

export default function Settings() {
  const q = useQuery({ queryKey: ['settings'], queryFn: api.settings, refetchInterval: 15_000 })
  const s = q.data
  if (q.error) return <ErrorNote error={q.error} />
  if (!s) return <p className="text-sm text-stone-500">Loading…</p>
  return (
    <div className="space-y-4 max-w-5xl">
      <h1 className="text-xl font-semibold">Settings</h1>
      <Inference s={s} />
      <General s={s} />
      <Forges s={s} />
      <Checks s={s} />
      <Schedule s={s} />
      <Groups s={s} />
      <Mcp s={s} />
    </div>
  )
}

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['settings'] })
    void qc.invalidateQueries({ queryKey: ['overview'] })
  }
}

function Inference({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const [f, setF] = useState(s.config.inference)
  useEffect(() => { setF(s.config.inference) }, [s.config.inference])
  const [bearer, setBearer] = useState('')
  const save = useMutation({ mutationFn: () => api.putInference(f), onSuccess: refresh })
  const saveBearer = useMutation({ mutationFn: (v: string | null) => api.putBearer(v), onSuccess: () => { setBearer(''); refresh() } })
  const test = useMutation({ mutationFn: api.testInference })
  const dirty = JSON.stringify(f) !== JSON.stringify(s.config.inference)
  return (
    <Card
      title="Inference"
      actions={<>
        {test.data && <Badge tone={test.data.ok ? 'green' : 'red'}>{test.data.ok ? 'reachable' : 'failing'}</Badge>}
        <Button onClick={() => test.mutate()} disabled={test.isPending}>{test.isPending ? 'Testing…' : 'Test'}</Button>
        <Button variant="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>Save</Button>
      </>}
    >
      <p className="text-xs text-stone-500 mb-3">
        The model behind every round, fix and chat turn. <b>claude-code</b> calls an agentic backend’s <code>query_claude</code> over MCP (directly or through a Beacon); the agent reaches the
        repository through Lamplighter’s workspace endpoint at the public URL. <b>openai</b> is any OpenAI-compatible <code>/chat/completions</code> with function calling; Lamplighter runs the tool loop itself.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Driver">
          <select className={inputCls} value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value as typeof f.driver })}>
            <option value="claude-code">claude-code (MCP query_claude)</option>
            <option value="openai">openai-compatible (function calling)</option>
          </select>
        </Field>
        <Field label={f.driver === 'openai' ? 'Base URL (…/v1)' : 'MCP endpoint URL'} hint={f.driver === 'openai' ? 'e.g. https://openrouter.ai/api/v1' : 'e.g. http://beacon-backend:9300/mcp'}>
          <input className={inputCls} value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
        </Field>
        {f.driver === 'claude-code' ? (
          <>
            <Field label="Tool name"><input className={inputCls} value={f.tool} onChange={(e) => setF({ ...f, tool: e.target.value })} /></Field>
            <Field label="Via" hint="beacon wraps the call in the aggregator’s `call` tool">
              <select className={inputCls} value={f.via} onChange={(e) => setF({ ...f, via: e.target.value as typeof f.via })}>
                <option value="beacon">beacon (aggregator)</option>
                <option value="direct">direct (the container itself)</option>
              </select>
            </Field>
            <Field label="Agent workdir (optional)"><input className={inputCls} value={f.workdir} onChange={(e) => setF({ ...f, workdir: e.target.value })} placeholder="backend default" /></Field>
          </>
        ) : (
          <>
            <Field label="Model"><input className={inputCls} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="e.g. anthropic/claude-sonnet-5.5" /></Field>
            <Field label="Max tool rounds"><input type="number" className={inputCls} value={f.max_tool_rounds} onChange={(e) => setF({ ...f, max_tool_rounds: Number(e.target.value) })} /></Field>
          </>
        )}
        <Field label="Session timeout (s)"><input type="number" className={inputCls} value={f.timeout_s} onChange={(e) => setF({ ...f, timeout_s: Number(e.target.value) })} /></Field>
        <Field label="Bearer token" hint={s.inference_bearer ? `set (${s.inference_bearer})` : 'none — Beacon needs none'}>
          <div className="flex gap-2">
            <input type="password" className={inputCls} value={bearer} onChange={(e) => setBearer(e.target.value)} placeholder="write-only" />
            <Button disabled={!bearer} onClick={() => saveBearer.mutate(bearer)}>Set</Button>
            {s.inference_bearer && <Button variant="ghost" onClick={() => saveBearer.mutate(null)}>Clear</Button>}
          </div>
        </Field>
      </div>
      {test.data && <p className={`mt-2 text-sm ${test.data.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-300'}`}>{test.data.detail}</p>}
      <ErrorNote error={save.error || saveBearer.error || test.error} />
    </Card>
  )
}

function General({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const [url, setUrl] = useState(s.config.public_url)
  const [id, setId] = useState(s.config.identity)
  const save = useMutation({ mutationFn: () => api.putGeneral({ public_url: url, identity: id }), onSuccess: refresh })
  const dirty = url !== s.config.public_url || JSON.stringify(id) !== JSON.stringify(s.config.identity)
  return (
    <Card title="General" actions={<Button variant="primary" disabled={!dirty} onClick={() => save.mutate()}>Save</Button>}>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Public URL" hint="how the inference backend reaches Lamplighter (workspace callback)">
          <input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Commit author name"><input className={inputCls} value={id.name} onChange={(e) => setId({ ...id, name: e.target.value })} /></Field>
        <Field label="Commit author email"><input className={inputCls} value={id.email} onChange={(e) => setId({ ...id, email: e.target.value })} /></Field>
      </div>
      <ErrorNote error={save.error} />
    </Card>
  )
}

function Forges({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const blank = { id: '', kind: 'github', name: '', base_url: '', username: '', token: '', webhook_secret: '' }
  const [f, setF] = useState(blank)
  const [probe, setProbe] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const add = useMutation({ mutationFn: () => api.addForge(f), onSuccess: () => { setF(blank); refresh() } })
  const del = useMutation({ mutationFn: (id: string) => api.deleteForge(id), onSuccess: refresh })
  const doProbe = useMutation({ mutationFn: (id: string) => api.probeForge(id), onSuccess: (d, id) => setProbe((p) => ({ ...p, [id]: d })) })
  const [token, setToken] = useState<Record<string, string>>({})
  const setTok = useMutation({ mutationFn: (a: { id: string; token: string }) => api.patchForge(a.id, { token: a.token }), onSuccess: refresh })
  return (
    <Card title="Forges">
      <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-sm mb-4">
        {s.forges.map((x) => (
          <li key={x.id} className="py-2 flex flex-wrap items-center gap-2">
            <span className="font-medium">{x.name}</span><Badge>{x.kind}</Badge><code className="text-xs text-stone-500">{x.id}</code>
            <span className="text-xs text-stone-500 truncate max-w-xs">{x.base_url}</span>
            <Badge tone={x.token ? 'green' : 'stone'}>{x.token ? `token ${x.token}` : 'anonymous'}</Badge>
            {x.webhook_secret && <Badge tone="blue">webhook</Badge>}
            {probe[x.id] && <Badge tone={probe[x.id]!.ok ? 'green' : 'red'}>{probe[x.id]!.detail}</Badge>}
            <span className="ml-auto flex gap-2">
              <input type="password" className={`${inputCls} !w-40 !py-1 text-xs`} placeholder="new token" value={token[x.id] ?? ''} onChange={(e) => setToken({ ...token, [x.id]: e.target.value })} />
              <Button className="!py-1 text-xs" disabled={!token[x.id]} onClick={() => setTok.mutate({ id: x.id, token: token[x.id]! })}>Set</Button>
              <Button className="!py-1 text-xs" onClick={() => doProbe.mutate(x.id)}>Probe</Button>
              <Button variant="danger" className="!py-1 text-xs" onClick={() => del.mutate(x.id)}>Remove</Button>
            </span>
            {x.webhook_secret && x.kind !== 'git' && <div className="w-full text-[11px] text-stone-500">Webhook URL: <code>{s.config.public_url}/hooks/{x.kind}/{x.id}</code> (push events, JSON, with the secret)</div>}
          </li>
        ))}
      </ul>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Id"><input className={inputCls} value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="github" /></Field>
        <Field label="Kind">
          <select className={inputCls} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="github">GitHub</option><option value="gitea">Gitea</option><option value="git">bare git</option>
          </select>
        </Field>
        <Field label="Name"><input className={inputCls} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label={f.kind === 'git' ? 'Remote prefix' : f.kind === 'gitea' ? 'Base URL' : 'API URL (optional)'} hint={f.kind === 'git' ? 'e.g. ssh://git@host/srv or a path' : undefined}>
          <input className={inputCls} value={f.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} placeholder={f.kind === 'gitea' ? 'https://gitea.example' : ''} />
        </Field>
        <Field label="Username (git auth)"><input className={inputCls} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Token" hint="fine-grained; contents + pull requests write"><input type="password" className={inputCls} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} /></Field>
        <Field label="Webhook secret (optional)"><input type="password" className={inputCls} value={f.webhook_secret} onChange={(e) => setF({ ...f, webhook_secret: e.target.value })} /></Field>
        <div className="flex items-end"><Button variant="primary" disabled={!f.id || !f.name} onClick={() => add.mutate()}>Add forge</Button></div>
      </div>
      <ErrorNote error={add.error || del.error || doProbe.error || setTok.error} />
    </Card>
  )
}

function Checks({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const put = useMutation({ mutationFn: (a: { check: string; p: Partial<CheckSettings> }) => api.putCheck(a.check, a.p), onSuccess: refresh })
  const reload = useMutation({ mutationFn: api.reloadChecks, onSuccess: refresh })
  return (
    <Card title="Checks (global defaults)" actions={<Button onClick={() => reload.mutate()}>Reload check files</Button>}>
      <p className="text-xs text-stone-500 mb-2">Each check is a file in <code>/DATA/checks/</code> (prompt + frontmatter). These switches override its defaults for every repo; groups and repos can override them again.</p>
      <div className="overflow-x-auto -mx-4">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-stone-500 border-b border-stone-200 dark:border-stone-800">
            <th className="px-4 py-2 font-medium">Check</th><th className="px-2 py-2 font-medium">Enabled</th><th className="px-2 py-2 font-medium">Delivery</th>
            <th className="px-2 py-2 font-medium">Armed</th><th className="px-2 py-2 font-medium">Auto-submit</th><th className="px-2 py-2 font-medium">Cadence (days)</th>
          </tr></thead>
          <tbody>
            {s.checks.map((c) => (
              <tr key={c.kind} className="border-b last:border-0 border-stone-100 dark:border-stone-800/70">
                <td className="px-4 py-2"><div className="font-medium">{c.title}</div><div className="text-[11px] text-stone-500">{c.kind} · rev {c.revision} · {c.agent === 'none' ? 'detector' : 'LLM'} · {c.scopes.join('+')}{c.sensitive === 'always' ? ' · sensitive' : ''}</div></td>
                <td className="px-2 py-2"><input type="checkbox" checked={c.settings.enabled} onChange={(e) => put.mutate({ check: c.kind, p: { enabled: e.target.checked } })} /></td>
                <td className="px-2 py-2">{c.fixable ? (
                  <select className={`${inputCls} !w-auto !py-1`} value={c.settings.delivery} onChange={(e) => put.mutate({ check: c.kind, p: { delivery: e.target.value as CheckSettings['delivery'] } })}>
                    {['report', 'branch', 'pr', 'push'].map((d) => <option key={d}>{d}</option>)}
                  </select>) : <Badge>report only</Badge>}</td>
                <td className="px-2 py-2"><input type="checkbox" disabled={!c.fixable} checked={c.settings.armed} onChange={(e) => put.mutate({ check: c.kind, p: { armed: e.target.checked } })} /></td>
                <td className="px-2 py-2"><input type="checkbox" disabled={!c.fixable} checked={c.settings.auto_submit} onChange={(e) => put.mutate({ check: c.kind, p: { auto_submit: e.target.checked } })} /></td>
                <td className="px-2 py-2"><input type="number" min={1} className={`${inputCls} !w-20 !py-1`} defaultValue={c.settings.cadence_days} onBlur={(e) => Number(e.target.value) !== c.settings.cadence_days && put.mutate({ check: c.kind, p: { cadence_days: Number(e.target.value) } })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {s.check_errors.length > 0 && <div className="mt-2 text-xs text-red-600">{s.check_errors.map((e) => <div key={e}>{e}</div>)}</div>}
      <ErrorNote error={put.error || reload.error} />
    </Card>
  )
}

function Schedule({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const [f, setF] = useState(s.config.schedule)
  useEffect(() => { setF(s.config.schedule) }, [s.config.schedule])
  const save = useMutation({ mutationFn: () => api.putSchedule(f), onSuccess: refresh })
  const cancel = useMutation({ mutationFn: (id: string) => api.cancelJob(id), onSuccess: refresh })
  const dirty = JSON.stringify(f) !== JSON.stringify(s.config.schedule)
  const num = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}><input type="number" className={inputCls} value={f[k] as number} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></Field>
  )
  const sch = s.schedule
  return (
    <Card title="Schedule & budget" actions={<Button variant="primary" disabled={!dirty} onClick={() => save.mutate()}>Save</Button>}>
      <div className="flex flex-wrap gap-4 mb-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} /> Scheduler running (polling, queue, PR follow-up)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={f.rotation} onChange={(e) => setF({ ...f, rotation: e.target.checked })} /> Rotation: full rounds by cadence across the fleet</label>
      </div>
      <div className="grid gap-3 md:grid-cols-4">
        {num('slots', 'Concurrent sessions')}
        {num('sessions_per_day', 'Agent sessions / day', 'detector rounds are free')}
        {num('deliveries_per_day', 'Deliveries / day', 'auto-submit cap')}
        {num('open_items_per_repo', 'Open items per repo', 'attention cap')}
        {num('poll_min', 'Poll every (min)')}
        {num('debounce_min', 'Debounce pushes (min)')}
        {num('tick_s', 'Tick (s)')}
      </div>
      <div className="mt-4">
        <h3 className="text-xs font-semibold text-stone-500 mb-1">Queue — {sch.running.length} running, {sch.queued.length} queued · sessions today {sch.budget.sessions_today}/{sch.budget.sessions_per_day}</h3>
        <ul className="text-xs space-y-1">
          {[...sch.running, ...sch.queued].map((j) => (
            <li key={j.id} className="flex items-center gap-2">
              <Badge tone={j.state === 'running' ? 'amber' : 'stone'}>{j.state}</Badge>
              <span>{j.job === 'author' ? 'fix' : `${j.scope} round`} · {j.check_kind} · {j.repo_key}</span>
              <span className="text-stone-500">{j.foreground ? 'requested' : `tier ${j.tier}`} · {ago(j.created_at)}{j.waiting ? ` · waiting: ${j.waiting}` : ''}</span>
              {j.state === 'queued' && <button className="underline text-stone-500" onClick={() => cancel.mutate(j.id)}>cancel</button>}
            </li>
          ))}
          {sch.running.length + sch.queued.length === 0 && <li className="text-stone-500">Nothing queued.</li>}
        </ul>
      </div>
      <ErrorNote error={save.error || cancel.error} />
    </Card>
  )
}

function Groups({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const [n, setN] = useState({ id: '', name: '' })
  const add = useMutation({ mutationFn: () => api.addGroup(n), onSuccess: () => { setN({ id: '', name: '' }); refresh() } })
  return (
    <Card title="Groups & policy">
      <div className="space-y-3">
        {s.groups.map((g) => <GroupRow key={g.id} g={g} onSaved={refresh} />)}
      </div>
      <div className="mt-3 flex gap-2 items-end">
        <Field label="New group id"><input className={inputCls} value={n.id} onChange={(e) => setN({ ...n, id: e.target.value })} placeholder="yundera" /></Field>
        <Field label="Name"><input className={inputCls} value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} placeholder="Yundera" /></Field>
        <Button disabled={!n.id || !n.name} onClick={() => add.mutate()}>Add group</Button>
      </div>
      <ErrorNote error={add.error} />
    </Card>
  )
}

function GroupRow({ g, onSaved }: { g: { id: string; name: string; policy: string }; onSaved: () => void }) {
  const [policy, setPolicy] = useState(g.policy)
  const save = useMutation({ mutationFn: () => api.patchGroup(g.id, { policy }), onSuccess: onSaved })
  return (
    <div>
      <div className="flex items-center justify-between"><span className="text-sm font-medium">{g.name} <code className="text-xs text-stone-500">{g.id}</code></span>
        <Button className="!py-1 text-xs" disabled={policy === g.policy} onClick={() => save.mutate()}>Save policy</Button></div>
      <textarea className={`${inputCls} mt-1 min-h-16 font-mono text-xs`} value={policy} onChange={(e) => setPolicy(e.target.value)} />
    </div>
  )
}

function Mcp({ s }: { s: SettingsView }) {
  const [token, setToken] = useState<string>()
  const reveal = useMutation({ mutationFn: api.mcpToken, onSuccess: (d) => setToken(d.token) })
  const rotate = useMutation({ mutationFn: api.rotateMcpToken, onSuccess: (d) => setToken(d.token) })
  return (
    <Card title="Admin MCP">
      <p className="text-sm">Endpoint <code>{s.config.public_url}/mcp/admin</code> — Streamable HTTP, <code>Authorization: Bearer &lt;token&gt;</code>. Reads the fleet, requests rounds and fixes, dismisses findings, edits policy and switches. It cannot approve, merge, push or revert.</p>
      <div className="mt-2 flex items-center gap-2">
        <code className="text-xs bg-stone-100 dark:bg-stone-800 px-2 py-1 rounded">{token ?? s.admin_mcp_token}</code>
        <Button onClick={() => reveal.mutate()}>Reveal</Button>
        <Button variant="danger" onClick={() => rotate.mutate()}>Rotate</Button>
      </div>
      <p className="mt-2 text-[11px] text-stone-500">Announce it to a Beacon with a beaconify sidecar (see Apps/Lamplighter/docker-compose.yml). Page loaded {ago(new Date().toISOString())}.</p>
    </Card>
  )
}
