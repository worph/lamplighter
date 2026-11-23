import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ago, api, type CheckSettings, type Finding, type RepoDetail } from '../api'
import { Badge, Button, Card, Empty, ErrorNote, LampDot, Sha, inputCls, severityTone, stateTone } from '../components/ui'

export default function Repo() {
  const key = decodeURIComponent(useParams().key!)
  const qc = useQueryClient()
  const nav = useNavigate()
  const repo = useQuery({ queryKey: ['repo', key], queryFn: () => api.repo(key), refetchInterval: 5000 })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['repo', key] })
  const fetchNow = useMutation({ mutationFn: () => api.fetchRepo(key), onSuccess: refresh })
  const runAll = useMutation({ mutationFn: () => api.requestRound(key, 'all'), onSuccess: refresh })
  const del = useMutation({ mutationFn: () => api.deleteRepo(key), onSuccess: () => nav('/repos') })
  const r = repo.data
  if (repo.error) return <ErrorNote error={repo.error} />
  if (!r) return <p className="text-sm text-stone-500">Loading…</p>
  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/repos" className="text-xs text-stone-500 hover:underline">← Repositories</Link>
          <h1 className="text-xl font-semibold">{r.owner ? `${r.owner}/` : ''}{r.name}</h1>
          <div className="mt-1 flex flex-wrap gap-1.5 text-xs items-center">
            <Badge>{r.forge_id}</Badge>
            <Badge tone={r.visibility === 'public' ? 'blue' : 'stone'}>{r.visibility}</Badge>
            <Badge tone="violet">group {r.group.name}</Badge>
            <CredentialPin r={r} refresh={refresh} />
            <span className="text-stone-500">line <code>{r.line}</code> at <Sha sha={r.last_head} /> · fetched {ago(r.last_fetch_at)}</span>
          </div>
          {r.fetch_error && <p className="mt-1 text-xs text-red-600">Fetch failed: {r.fetch_error}</p>}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => fetchNow.mutate()} disabled={fetchNow.isPending}>{fetchNow.isPending ? 'Fetching…' : 'Fetch now'}</Button>
          <Button variant="primary" onClick={() => runAll.mutate()} disabled={runAll.isPending}>Run every check</Button>
        </div>
      </div>
      <ErrorNote error={fetchNow.error || runAll.error} />
      {!r.write.ok && (
        <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          <strong>Fixing is blocked on this repository.</strong> {r.write.why} Lamplighter keeps running rounds and
          writing reports, but drafts, validates and delivers no fix here until it has write access, so nothing is
          authored only to fail at the push. Pick another credential above, or see <Link className="underline" to="/settings">Settings → Forges</Link>.
        </div>
      )}
      <ChecksCard r={r} refresh={refresh} />
      <FindingsCard findings={r.findings} refresh={refresh} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Proposals">
          {r.proposals.length === 0 ? <Empty>No proposals yet.</Empty> : (
            <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-sm">
              {r.proposals.map((p) => (
                <li key={p.id} className="py-2">
                  <Link to={`/proposals/${p.id}`} className="hover:underline font-medium">{(p.summary ?? p.check_kind).split('\n')[0]}</Link>
                  <div className="flex gap-1.5 mt-0.5 text-xs items-center">
                    <Badge tone={stateTone(p.state)}>{p.state}</Badge><Badge>{p.check_kind}</Badge><Badge>{p.delivery}</Badge>
                    <span className="text-stone-500">{ago(p.updated_at)}</span>
                  </div>
                  {p.error && <p className="text-xs text-stone-500 mt-0.5 line-clamp-2">{p.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Rounds">
          {r.rounds.length === 0 ? <Empty>No rounds yet.</Empty> : (
            <ul className="divide-y divide-stone-100 dark:divide-stone-800 text-sm">
              {r.rounds.map((x) => (
                <li key={x.id} className="py-1.5 flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/rounds/${x.id}`} className="hover:underline">{x.check_kind} <span className="text-stone-500">{x.kind === 'round' ? x.scope : x.kind === 'author' ? 'fix' : 'validation'}</span></Link>
                    <div className="text-xs text-stone-500 truncate">{x.error ?? x.summary ?? ''}</div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0"><Badge tone={stateTone(x.status)}>{x.status}</Badge><span className="text-xs text-stone-500">{ago(x.started_at)}</span></div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <PolicyCard r={r} refresh={refresh} />
      <Card title="Log">
        <ul className="text-xs space-y-1 font-mono">
          {r.events.map((e) => (
            <li key={e.id} className={e.level === 'error' ? 'text-red-600' : e.level === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-stone-600 dark:text-stone-400'}>
              {e.at.slice(5, 19).replace('T', ' ')} {e.code} — {e.message}
            </li>
          ))}
        </ul>
      </Card>
      <div className="flex justify-end">
        <Button variant="danger" onClick={() => { if (prompt(`Type ${r.key} to stop monitoring it (findings and history are deleted).`) === r.key) del.mutate() }}>Remove repository</Button>
      </div>
    </div>
  )
}

function ChecksCard({ r, refresh }: { r: RepoDetail; refresh: () => void }) {
  const [msg, setMsg] = useState<string>()
  const round = useMutation({ mutationFn: (a: { check: string; scope: 'full' | 'diff' }) => api.requestRound(r.key, a.check, a.scope), onSuccess: () => { setMsg('Queued.'); refresh() } })
  const fix = useMutation({ mutationFn: (check: string) => api.requestFix(r.key, check), onSuccess: (d) => { setMsg(`Fix: ${d.result}`); refresh() } })
  const set = useMutation({ mutationFn: (a: { check: string; s: Partial<CheckSettings> | null }) => api.setRepoCheck(r.key, a.check, a.s), onSuccess: refresh })
  const own = r.settings.checks ?? {}
  const patch = (check: string, p: Partial<CheckSettings>) => set.mutate({ check, s: { ...(own[check] ?? {}), ...p } })
  return (
    <Card title="Checks" actions={msg && <span className="text-xs text-stone-500">{msg}</span>}>
      <div className="overflow-x-auto -m-4">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-stone-500 border-b border-stone-200 dark:border-stone-800">
              <th className="px-4 py-2 font-medium">Check</th>
              <th className="px-2 py-2 font-medium">Enabled</th>
              <th className="px-2 py-2 font-medium">Delivery</th>
              <th className="px-2 py-2 font-medium" title="Start fixing by itself after a round">Armed</th>
              <th className="px-2 py-2 font-medium" title="Validation passing is the approval">Auto-submit</th>
              <th className="px-2 py-2 font-medium">Last round</th>
              <th className="px-4 py-2 font-medium text-right">Run</th>
            </tr>
          </thead>
          <tbody>
            {r.checks.map((c) => {
              const blocked = !r.write.ok
              const lamp = r.lamps[c.kind]
              const overridden = !!own[c.kind]
              return (
                <tr key={c.kind} className="border-b last:border-0 border-stone-100 dark:border-stone-800/70">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2"><LampDot state={lamp?.lamp ?? 'unlit'} count={lamp?.open} /> <span className="font-medium">{c.title}</span></div>
                    <div className="text-[11px] text-stone-500 ml-5">{c.kind} · {c.agent === 'none' ? 'detector' : 'LLM review'}{overridden && <> · <button className="underline" onClick={() => set.mutate({ check: c.kind, s: null })}>reset to group/global</button></>}</div>
                  </td>
                  <td className="px-2 py-2"><input type="checkbox" checked={c.settings.enabled} onChange={(e) => patch(c.kind, { enabled: e.target.checked })} /></td>
                  <td className="px-2 py-2">
                    <select className={`${inputCls} !w-auto !py-1`} value={c.settings.delivery} onChange={(e) => patch(c.kind, { delivery: e.target.value as CheckSettings['delivery'] })}>
                        {['report', 'branch', 'pr', 'push'].map((d) => <option key={d} value={d} disabled={blocked && d !== 'report'}>{d}{blocked && d !== 'report' ? ' (no write access)' : ''}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-2"><input type="checkbox" disabled={blocked} title={blocked ? 'blocked: no write access' : undefined} checked={c.settings.armed} onChange={(e) => patch(c.kind, { armed: e.target.checked })} /></td>
                  <td className="px-2 py-2"><input type="checkbox" disabled={blocked} title={blocked ? 'blocked: no write access' : undefined} checked={c.settings.auto_submit} onChange={(e) => patch(c.kind, { auto_submit: e.target.checked })} /></td>
                  <td className="px-2 py-2 text-xs text-stone-500">{lamp?.status ? <Badge tone={stateTone(lamp.status)}>{lamp.status}</Badge> : null} {ago(lamp?.last)}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    <Button className="!px-2 !py-1 text-xs" onClick={() => round.mutate({ check: c.kind, scope: 'full' })}>Round</Button>{' '}
                    {c.settings.delivery !== 'report' && <Button className="!px-2 !py-1 text-xs" onClick={() => fix.mutate(c.kind)} disabled={blocked || !lamp?.open} title={blocked ? 'blocked: no write access' : undefined}>Fix</Button>}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <ErrorNote error={round.error || fix.error || set.error} />
    </Card>
  )
}

function FindingsCard({ findings, refresh }: { findings: Finding[]; refresh: () => void }) {
  const [show, setShow] = useState<'active' | 'all'>('active')
  const [open, setOpen] = useState<string>()
  const dismiss = useMutation({ mutationFn: (a: { id: string; reason: string }) => api.dismiss(a.id, a.reason), onSuccess: refresh })
  const reopen = useMutation({ mutationFn: (id: string) => api.reopen(id), onSuccess: refresh })
  const list = show === 'active' ? findings.filter((f) => f.state === 'open' || f.state === 'proposed') : findings
  return (
    <Card
      title={`Findings (${findings.filter((f) => f.state === 'open' || f.state === 'proposed').length} active)`}
      actions={
        <select className={`${inputCls} !w-auto !py-1 text-xs`} value={show} onChange={(e) => setShow(e.target.value as 'active' | 'all')}>
          <option value="active">open & proposed</option>
          <option value="all">all, including dismissed, fixed, gone</option>
        </select>
      }
    >
      {list.length === 0 ? <Empty>Nothing here — the lamps are lit.</Empty> : (
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {list.map((f) => (
            <li key={f.id} className="py-2">
              <button className="w-full text-left" onClick={() => setOpen(open === f.id ? undefined : f.id)}>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={severityTone(f.severity)}>{f.severity}</Badge>
                  <Badge>{f.check_kind}</Badge>
                  <span className="text-sm font-medium">{f.title}</span>
                  <Badge tone={stateTone(f.state)}>{f.state}</Badge>
                  {f.sensitive ? <Badge tone="red">sensitive</Badge> : null}
                </div>
                <div className="text-xs text-stone-500 mt-0.5"><code>{f.anchor}</code> · {f.category} · {ago(f.updated_at)}</div>
              </button>
              {open === f.id && (
                <div className="mt-2 rounded-lg bg-stone-50 dark:bg-stone-950 p-3 space-y-2">
                  <pre className="whitespace-pre-wrap text-xs font-sans">{f.body || '(no detail)'}</pre>
                  {f.dismissal && <p className="text-xs text-violet-700 dark:text-violet-300">Dismissed by {f.dismissal.by}: “{f.dismissal.reason}”</p>}
                  <div className="flex gap-2">
                    {f.state === 'open' && <DismissButton onDismiss={(reason) => dismiss.mutate({ id: f.id, reason })} />}
                    {(f.state === 'dismissed' || f.state === 'gone') && <Button onClick={() => reopen.mutate(f.id)}>Reopen</Button>}
                    {f.proposal_id && <Link className="text-sm underline self-center" to={`/proposals/${f.proposal_id}`}>proposal</Link>}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <ErrorNote error={dismiss.error || reopen.error} />
    </Card>
  )
}

export function DismissButton({ onDismiss }: { onDismiss: (reason: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  if (!editing) return <Button onClick={() => setEditing(true)}>Dismiss…</Button>
  return (
    <form className="flex gap-2 flex-1" onSubmit={(e) => { e.preventDefault(); if (reason.trim().length >= 3) { onDismiss(reason); setEditing(false) } }}>
      <input autoFocus className={inputCls} placeholder="Why won’t this be fixed? (kept until the code changes)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button type="submit" variant="primary" disabled={reason.trim().length < 3}>Dismiss</Button>
      <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
    </form>
  )
}

function PolicyCard({ r, refresh }: { r: RepoDetail; refresh: () => void }) {
  const [policy, setPolicy] = useState(r.policy)
  useEffect(() => { setPolicy(r.policy) }, [r.policy])
  const save = useMutation({ mutationFn: () => api.patchRepo(r.key, { policy }), onSuccess: refresh })
  return (
    <Card title="Policy" actions={<Button disabled={policy === r.policy || save.isPending} onClick={() => save.mutate()}>Save</Button>}>
      <p className="text-xs text-stone-500 mb-2">Prose rules for this repository, given to every check after the group policy. A <code>LAMPLIGHTER.md</code> or <code>CLAUDE.md</code> in the repo is read too.</p>
      <textarea className={`${inputCls} min-h-24 font-mono text-xs`} value={policy} onChange={(e) => setPolicy(e.target.value)} placeholder="e.g. src/legacy is frozen — never propose changes there." />
      {r.group.policy && <p className="text-xs text-stone-500 mt-2">Group “{r.group.name}”: {r.group.policy}</p>}
      <ErrorNote error={save.error} />
    </Card>
  )
}

const VIA = { repo: 'pinned', group: `pinned on the group`, auto: 'auto: the one that may push', default: 'forge default' } as const

/** Which account Lamplighter speaks as here: auto by default, or pinned (Settings-only, like tokens). */
function CredentialPin({ r, refresh }: { r: RepoDetail; refresh: () => void }) {
  const pin = useMutation({ mutationFn: (credential_id: string | null) => api.patchRepo(r.key, { credential_id }), onSuccess: refresh })
  if (!r.credentials.length) return null
  const autoLabel = r.credential && !r.credential_id ? `${r.credential.label} (${VIA[r.credential.via]})` : 'auto'
  return (
    <label className="flex items-center gap-1 text-stone-500" title={r.credential ? `${r.credential.label}${r.credential.login ? ` — ${r.credential.login}` : ''} · ${VIA[r.credential.via]}` : undefined}>
      as
      <select className={`${inputCls} !w-auto !py-0.5 text-xs`} value={r.credential_id ?? ''} disabled={pin.isPending} onChange={(e) => pin.mutate(e.target.value || null)}>
        <option value="">{autoLabel}</option>
        {r.credentials.map((c) => <option key={c.id} value={c.id}>pin: {c.label}{c.login ? ` (${c.login})` : ''}</option>)}
      </select>
      {pin.error && <span className="text-red-600">{(pin.error as Error).message}</span>}
    </label>
  )
}
