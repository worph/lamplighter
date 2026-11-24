import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, api, type CheckSettings, type Credential, type Forge, type Group, type RepoCredential, type SettingsView } from '../api'
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
        <b>text</b> is the same loop for an endpoint with no function calling, such as Claude Code’s OpenAI API: the tools are described in the prompt and the backend needs no route back to Lamplighter.
      </p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Driver">
          <select className={inputCls} value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value as typeof f.driver })}>
            <option value="claude-code">claude-code (MCP query_claude)</option>
            <option value="openai">openai-compatible (function calling)</option>
            <option value="text">openai-compatible, text only (e.g. Claude Code’s API)</option>
          </select>
        </Field>
        <Field label={f.driver === 'claude-code' ? 'MCP endpoint URL' : 'Base URL (…/v1)'} hint={f.driver === 'openai' ? 'e.g. https://openrouter.ai/api/v1' : f.driver === 'text' ? 'e.g. http://claude-router:9091/v1' : 'e.g. http://beacon-backend:9300/mcp'}>
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
            <Field label="Model"><input className={inputCls} value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder={f.driver === 'text' ? 'e.g. sonnet (empty: the backend’s default)' : 'e.g. anthropic/claude-sonnet-5.5'} /></Field>
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
        <Field label="Commit author email" hint="a credential’s own wins; empty: a GitHub credential’s noreply address"><input className={inputCls} value={id.email} onChange={(e) => setId({ ...id, email: e.target.value })} /></Field>
      </div>
      <ErrorNote error={save.error} />
    </Card>
  )
}

function Forges({ s }: { s: SettingsView }) {
  const refresh = useRefresh()
  const blank = { id: '', kind: 'github', name: '', base_url: '', webhook_secret: '' }
  const [f, setF] = useState(blank)
  const [probe, setProbe] = useState<Record<string, { ok: boolean; detail: string }>>({})
  const add = useMutation({ mutationFn: () => api.addForge(f), onSuccess: () => { setF(blank); refresh() } })
  const del = useMutation({ mutationFn: (id: string) => api.deleteForge(id), onSuccess: refresh })
  const doProbe = useMutation({ mutationFn: (id: string) => api.probeForge(id), onSuccess: (d, id) => setProbe((p) => ({ ...p, [id]: d })) })
  return (
    <Card title="Forges & credentials">
      <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-sm mb-4">
        {s.forges.map((x) => (
          <li key={x.id} className="py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{x.name}</span><Badge>{x.kind}</Badge><code className="text-xs text-stone-500">{x.id}</code>
              <span className="text-xs text-stone-500 truncate max-w-xs">{x.base_url}</span>
              {x.webhook_secret && <Badge tone="blue">webhook</Badge>}
              {probe[x.id] && <Badge tone={probe[x.id]!.ok ? 'green' : 'red'}>{probe[x.id]!.detail}</Badge>}
              <span className="ml-auto flex gap-2">
                <Button className="!py-1 text-xs" onClick={() => doProbe.mutate(x.id)}>Probe</Button>
                <Button variant="danger" className="!py-1 text-xs" onClick={() => del.mutate(x.id)}>Remove</Button>
              </span>
            </div>
            {x.webhook_secret && x.kind !== 'git' && <div className="mt-1 text-[11px] text-stone-500">Webhook URL: <code>{s.config.public_url}/hooks/{x.kind}/{x.id}</code> (push events, JSON, with the secret)</div>}
            {x.kind === 'git'
              ? <p className="mt-1 text-[11px] text-stone-500">Bare git authenticates with the container’s SSH key (or the remote’s own credentials), not a token.</p>
              : <ForgeCredentials forge={x} identity={s.config.identity} />}
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
        <Field label="Webhook secret (optional)"><input type="password" className={inputCls} value={f.webhook_secret} onChange={(e) => setF({ ...f, webhook_secret: e.target.value })} /></Field>
        <div className="flex items-end"><Button variant="primary" disabled={!f.id || !f.name} onClick={() => add.mutate()}>Add forge</Button></div>
      </div>
      <p className="mt-2 text-[11px] text-stone-500">One forge per host. Its credentials — one per account or organisation — are added on the forge once it exists.</p>
      <ErrorNote error={add.error || del.error || doProbe.error} />
    </Card>
  )
}

const GH_TOKENS_URL = 'https://github.com/settings/tokens'
const GH_NEW_FINE_GRAINED_URL = 'https://github.com/settings/personal-access-tokens/new'

const VIA: Record<RepoCredential['via'], string> = { repo: 'pinned', group: 'group pin', auto: 'auto', default: 'default' }

/**
 * A forge's credentials: one per account Lamplighter speaks as. Each repo uses the one pinned on it
 * or its group, else the one whose check says it may push there, else the forge default.
 */
function ForgeCredentials({ forge: x, identity }: { forge: Forge; identity: { name: string; email: string } }) {
  const refresh = useRefresh()
  const [label, setLabel] = useState('')
  const add = useMutation({ mutationFn: () => api.addCredential(x.id, { label }), onSuccess: () => { setLabel(''); refresh() } })
  const check = useMutation({ mutationFn: () => api.checkForge(x.id), onSuccess: refresh })
  const blocked = x.repos.filter((r) => !r.write.ok)
  const owners = [...new Set(x.repos.map((r) => r.repo.split('/')[0]).filter(Boolean))]
  return (
    <div className="mt-3 space-y-3">
      <TokenGuide forge={x} owners={owners} />
      {x.credentials.map((c) => <CredentialCard key={c.id} forge={x} c={c} identity={identity} />)}
      {x.credentials.length === 0 && <p className="text-xs text-amber-700 dark:text-amber-300">No credential: Lamplighter reads public repositories here and cannot push, open pull requests or see private ones.</p>}
      <div className="flex flex-wrap items-center gap-2">
        <input className={`${inputCls} !w-auto flex-1 min-w-[12rem]`} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={x.kind === 'github' ? 'e.g. “Me”, “Acme org”, “lamp-bot”' : 'e.g. “lamp-bot”'}
          onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) add.mutate() }} />
        <Button disabled={!label.trim() || add.isPending} onClick={() => add.mutate()}>Add credential</Button>
        {x.credentials.some((c) => c.token_set) && <Button disabled={check.isPending} onClick={() => check.mutate()}>{check.isPending ? 'checking…' : 'Check all'}</Button>}
      </div>
      {x.repos.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-stone-600 dark:text-stone-400">
            Which credential each repository uses — {x.repos.length - blocked.length} of {x.repos.length} can be fixed{blocked.length ? `, ${blocked.length} read-only` : ''}
          </summary>
          <p className="mt-1 text-[11px] text-stone-500">Pin a credential on a repository (its page) or on a group (Groups & policy below); otherwise the one that may push there is used.</p>
          <ul className="mt-1 space-y-0.5">
            {x.repos.map((r) => (
              <li key={r.key} className="flex flex-wrap items-center gap-2">
                <Link to={`/repos/${encodeURIComponent(r.key)}`} className="hover:underline"><code>{r.repo}</code></Link>
                {r.credential ? <Badge tone={r.credential.via === 'repo' || r.credential.via === 'group' ? 'violet' : 'stone'}>{r.credential.label} · {VIA[r.credential.via]}</Badge> : <Badge tone="amber">no credential</Badge>}
                {!r.write.ok && <span className="text-amber-700 dark:text-amber-300" title={r.write.why}>read-only</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <ErrorNote error={add.error || check.error} />
    </div>
  )
}

/** What kind of token to make and exactly how to scope it (Touchstone's guide). */
function TokenGuide({ forge: x, owners }: { forge: Forge; owners: string[] }) {
  const list = (items: string[]) => items.length ? items.map((o, i) => <span key={o}>{i ? ', ' : ''}<code>{o}</code></span>) : null
  return (
    <details className="rounded-md border border-stone-200 dark:border-stone-800 p-3 text-xs text-stone-600 dark:text-stone-400 leading-relaxed">
      <summary className="cursor-pointer font-medium">How to make a {x.kind === 'github' ? 'GitHub' : 'Gitea'} token</summary>
      <p className="mt-2">
        Each credential is an account Lamplighter pushes branches, pushes and pull requests as. Everything it delivers
        carries that account’s name, so use one that may speak for those repositories: a bot account,
        or an organisation-owned token — not your personal one unless you want the changes to be yours.
        {x.kind === 'github' && <> Make a <strong>fine-grained</strong> personal access token, <strong>not a classic one</strong>: a classic token reaches every repository the account can, a fine-grained one only the repositories you pick.</>}
      </p>
      {x.kind === 'github' ? (
        <ol className="mt-2 list-decimal pl-5 space-y-0.5">
          <li>Open <a className="underline" href={GH_TOKENS_URL} target="_blank" rel="noreferrer">github.com/settings/tokens</a> → <em>Fine-grained tokens</em> → <em>Generate new token</em> (or go <a className="underline" href={GH_NEW_FINE_GRAINED_URL} target="_blank" rel="noreferrer">straight to the form</a>).</li>
          <li><strong>Resource owner:</strong> one token reaches one owner, so add <strong>one credential per owner</strong>{owners.length ? <> ({list(owners)})</> : ''}. Each repository then uses the credential that may push there, with no pinning. For an organisation, pick the organisation, not your own account.</li>
          <li><strong>Repository access:</strong> <em>Only select repositories</em> → the ones Lamplighter monitors under that owner. Add new ones to the token as you add them here.</li>
          <li><strong>Repository permissions:</strong> <em>Contents</em> read and write (to push its <code>lamplighter/…</code> branches, or the line for <code>push</code> delivery), <em>Pull requests</em> read and write, <em>Metadata</em> read-only (GitHub adds it). Nothing else.</li>
          <li><strong>Expiration</strong> is your call. When it lapses the credential turns failing and an alert opens; paste a new one here.</li>
          <li>If the organisation requires approval, an owner approves it under the organisation’s <em>Settings → Personal access tokens</em>; until then GitHub refuses it.</li>
        </ol>
      ) : (
        <ol className="mt-2 list-decimal pl-5 space-y-0.5">
          <li>On {x.base_url ? <code>{x.base_url}</code> : 'the Gitea instance'}, signed in as the account Lamplighter should act as: <em>Settings → Applications → Generate new token</em>.</li>
          <li><strong>Permissions:</strong> <em>repository</em> read and write, <em>issue</em> read and write (labels on pull requests), <em>user</em> read. Nothing else.</li>
          <li>The account needs write access to the repositories that should use it.</li>
        </ol>
      )}
      <p className="mt-1">
        Once, by hand, on each repository: create a <code>lamplighter</code> label{x.kind === 'github' ? ' — the token deliberately cannot create labels; without it pull requests still open, unlabelled' : ' (Lamplighter creates it if the token may)'}.
      </p>
    </details>
  )
}

/**
 * One credential, Touchstone's way: write-only token (the field is emptied on save and the token
 * is never shown), checked in the same response, plus who its commits are by.
 */
function CredentialCard({ forge: x, c, identity }: { forge: Forge; c: Credential; identity: { name: string; email: string } }) {
  const refresh = useRefresh()
  const [token, setToken] = useState('')
  const [f, setF] = useState({ label: c.label, username: c.username ?? '', commit_name: c.commit_name ?? '', commit_email: c.commit_email ?? '' })
  useEffect(() => { setF({ label: c.label, username: c.username ?? '', commit_name: c.commit_name ?? '', commit_email: c.commit_email ?? '' }) }, [c.label, c.username, c.commit_name, c.commit_email])
  const done = () => { setToken(''); refresh() }
  const save = useMutation({ mutationFn: () => api.setCredentialToken(c.id, token), onSuccess: done })
  const clear = useMutation({ mutationFn: () => api.clearCredentialToken(c.id), onSuccess: done })
  const check = useMutation({ mutationFn: () => api.checkCredential(c.id), onSuccess: refresh })
  const patch = useMutation({ mutationFn: (b: Parameters<typeof api.patchCredential>[1]) => api.patchCredential(c.id, b), onSuccess: refresh })
  const remove = useMutation({ mutationFn: () => api.deleteCredential(c.id), onSuccess: refresh })
  const busy = save.isPending || clear.isPending || check.isPending
  const a = c.auth
  const dirty = f.label !== c.label || f.username !== (c.username ?? '') || f.commit_name !== (c.commit_name ?? '') || f.commit_email !== (c.commit_email ?? '')
  const pushes = a.repos?.filter((r) => r.push).length ?? 0
  const status =
    a.state === 'ok' ? `works — as ${a.login}`
      : a.state === 'failing' ? `does not work — ${a.problems.join('; ')}`
        : a.state === 'unknown' ? 'not checked yet'
          : 'no token yet'
  const usesNoreply = !c.commit_email && (!identity.email || identity.email === 'lamplighter@localhost')
  return (
    <div className="rounded-md border border-stone-200 dark:border-stone-800 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{c.label}</span>
        {c.is_default ? <Badge tone="blue">default</Badge> : <button className="text-[11px] underline text-stone-500" onClick={() => patch.mutate({ is_default: true })}>make default</button>}
        <Badge tone={c.token_set ? 'stone' : 'amber'}>{c.token_set ? (c.token_set_at ? `token set ${ago(c.token_set_at)}` : 'token set') : 'no token'}</Badge>
        <Badge tone={a.state === 'ok' ? 'green' : a.state === 'failing' ? 'red' : 'stone'}>{status}</Badge>
        {a.checked_at && <span className="text-[11px] text-stone-500">checked {ago(a.checked_at)}</span>}
        <Button variant="danger" className="ml-auto !py-1 text-xs" disabled={remove.isPending}
          onClick={() => { if (window.confirm(`Remove the “${c.label}” credential? Repositories and groups pinned to it go back to auto.`)) remove.mutate() }}>Remove</Button>
      </div>

      <div className="mt-2 grid gap-2 md:grid-cols-4">
        <Field label="Label"><input className={inputCls} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></Field>
        <Field label="Git username (optional)" hint={x.kind === 'github' ? 'empty: x-access-token' : 'empty: lamplighter'}><input className={inputCls} value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label="Commit author name" hint={`empty: ${identity.name || 'Lamplighter'} (General)`}><input className={inputCls} value={f.commit_name} onChange={(e) => setF({ ...f, commit_name: e.target.value })} /></Field>
        <Field label="Commit author email" hint={usesNoreply && a.login && x.kind === 'github' ? `empty: ${a.user_id}+${a.login}@users.noreply.github.com` : 'empty: General → commit author email'}>
          <input className={inputCls} value={f.commit_email} onChange={(e) => setF({ ...f, commit_email: e.target.value })} />
        </Field>
      </div>
      {dirty && <div className="mt-2"><Button className="!py-1 text-xs" variant="primary" disabled={patch.isPending} onClick={() => patch.mutate(f)}>Save details</Button></div>}

      {a.repos && a.repos.length > 0 && (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-stone-600 dark:text-stone-400">May push to {pushes} of {a.repos.length} repositories on {x.name}</summary>
          <ul className="mt-1 space-y-0.5">
            {a.repos.map((r) => (
              <li key={r.repo} className="flex flex-wrap gap-2 items-center">
                <Badge tone={r.push ? 'green' : 'stone'}>{r.push ? 'can push' : 'cannot push'}</Badge><code>{r.repo}</code>
                {r.detail && <span className="text-stone-500">{r.detail}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="password" autoComplete="off" spellCheck={false} aria-label={`${c.label} token`}
          className={`${inputCls} !w-auto flex-1 min-w-[14rem]`}
          placeholder={c.token_set ? 'paste a new token to replace it' : x.kind === 'github' ? 'github_pat_…' : 'token'}
          value={token} onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && token.trim() && !busy) save.mutate() }}
        />
        <Button variant="primary" disabled={busy || !token.trim()} onClick={() => save.mutate()}>{save.isPending ? 'checking…' : c.token_set ? 'Replace' : 'Save'}</Button>
        {c.token_set && <Button disabled={busy} onClick={() => check.mutate()}>{check.isPending ? 'checking…' : 'Check again'}</Button>}
        {c.token_set && (
          <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Clear the “${c.label}” token? Repositories using it can no longer be fixed.`)) clear.mutate() }}>Clear token</Button>
        )}
      </div>
      <p className="mt-2 text-[11px] text-stone-500">
        Kept in Lamplighter’s database and never shown again. It takes effect at once, and it is checked every
        half hour. Only this page sets tokens and pins: the chat and the admin MCP cannot choose whose name Lamplighter pushes under.
      </p>
      <ErrorNote error={save.error || clear.error || check.error || patch.error || remove.error} />
    </div>
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
                <td className="px-2 py-2">
                  <select className={`${inputCls} !w-auto !py-1`} value={c.settings.delivery} onChange={(e) => put.mutate({ check: c.kind, p: { delivery: e.target.value as CheckSettings['delivery'] } })}>
                    {['report', 'branch', 'pr', 'push'].map((d) => <option key={d}>{d}</option>)}
                  </select></td>
                <td className="px-2 py-2"><input type="checkbox" checked={c.settings.armed} onChange={(e) => put.mutate({ check: c.kind, p: { armed: e.target.checked } })} /></td>
                <td className="px-2 py-2"><input type="checkbox" checked={c.settings.auto_submit} onChange={(e) => put.mutate({ check: c.kind, p: { auto_submit: e.target.checked } })} /></td>
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
        {num('sessions_per_hour', 'Agent sessions / hour', 'detector rounds are free')}
        {num('deliveries_per_hour', 'Deliveries / hour', 'auto-submit cap')}
        {num('open_items_per_repo', 'Open items per repo', 'attention cap')}
        {num('poll_min', 'Poll every (min)')}
        {num('debounce_min', 'Debounce pushes (min)')}
        {num('tick_s', 'Tick (s)')}
      </div>
      <div className="mt-4">
        <h3 className="text-xs font-semibold text-stone-500 mb-1">Queue — {sch.running.length} running, {sch.queued.length} queued · sessions this hour {sch.budget.sessions_this_hour}/{sch.budget.sessions_per_hour}</h3>
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
        {s.groups.map((g) => <GroupRow key={g.id} g={g} forges={s.forges} onSaved={refresh} />)}
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

function GroupRow({ g, forges, onSaved }: { g: Group; forges: Forge[]; onSaved: () => void }) {
  const [policy, setPolicy] = useState(g.policy)
  const save = useMutation({ mutationFn: () => api.patchGroup(g.id, { policy }), onSuccess: onSaved })
  const pin = useMutation({ mutationFn: (credential_id: string | null) => api.patchGroup(g.id, { credential_id }), onSuccess: onSaved })
  const withCreds = forges.filter((x) => x.credentials.length)
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{g.name} <code className="text-xs text-stone-500">{g.id}</code></span>
        <span className="flex flex-wrap items-center gap-2">
          {withCreds.length > 0 && (
            <label className="text-xs text-stone-500 flex items-center gap-1" title="Applies to this group's repositories on that credential's forge; a repository's own pin wins">
              Credential
              <select className={`${inputCls} !w-auto !py-1 text-xs`} value={g.credential_id ?? ''} onChange={(e) => pin.mutate(e.target.value || null)}>
                <option value="">auto (the one that may push)</option>
                {withCreds.map((x) => (
                  <optgroup key={x.id} label={x.name}>
                    {x.credentials.map((c) => <option key={c.id} value={c.id}>{x.name} · {c.label}</option>)}
                  </optgroup>
                ))}
              </select>
            </label>
          )}
          <Button className="!py-1 text-xs" disabled={policy === g.policy} onClick={() => save.mutate()}>Save policy</Button>
        </span>
      </div>
      <textarea className={`${inputCls} mt-1 min-h-16 font-mono text-xs`} value={policy} onChange={(e) => setPolicy(e.target.value)} />
      <ErrorNote error={save.error || pin.error} />
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
