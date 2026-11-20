import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ago, api, type ProposalRow } from '../api'
import { Badge, Button, Card, ErrorNote, Markdown, Sha, inputCls, severityTone, stateTone } from '../components/ui'

export function Diff({ patch }: { patch: string }) {
  return (
    <pre className="text-xs font-mono overflow-x-auto rounded-lg bg-stone-50 dark:bg-stone-950 p-3 max-h-[600px]">
      {patch.split('\n').map((l, i) => (
        <div
          key={i}
          className={
            l.startsWith('+') && !l.startsWith('+++') ? 'text-emerald-700 dark:text-emerald-400 bg-emerald-50/60 dark:bg-emerald-950/40'
            : l.startsWith('-') && !l.startsWith('---') ? 'text-red-700 dark:text-red-400 bg-red-50/60 dark:bg-red-950/40'
            : l.startsWith('@@') ? 'text-sky-700 dark:text-sky-400'
            : l.startsWith('diff ') ? 'font-semibold text-stone-700 dark:text-stone-300 mt-2'
            : 'text-stone-600 dark:text-stone-400'
          }
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  )
}

/** A decisive action guarded by typing the proposal id — the same rule as the chat. */
export function Confirmed({ label, word, onConfirm, variant = 'primary', busy }: { label: string; word: string; onConfirm: () => void; variant?: 'primary' | 'danger'; busy?: boolean }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  if (!open) return <Button variant={variant} onClick={() => setOpen(true)} disabled={busy}>{label}</Button>
  return (
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (typed === word) { onConfirm(); setOpen(false) } }}>
      <input autoFocus className={`${inputCls} !w-56 font-mono text-xs`} placeholder={`type ${word}`} value={typed} onChange={(e) => setTyped(e.target.value)} />
      <Button type="submit" variant={variant} disabled={typed !== word}>{label}</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  )
}

export function ProposalActions({ p, onDone }: { p: ProposalRow; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const approve = useMutation({ mutationFn: () => api.approve(p.id), onSuccess: onDone })
  const reject = useMutation({ mutationFn: () => api.reject(p.id, reason), onSuccess: onDone })
  const merge = useMutation({ mutationFn: () => api.merge(p.id), onSuccess: onDone })
  const revert = useMutation({ mutationFn: () => api.revert(p.id), onSuccess: onDone })
  const blocked = p.write?.ok === false
  const busy = approve.isPending || reject.isPending || merge.isPending || revert.isPending
  const ref = p.submitted_ref ? (JSON.parse(p.submitted_ref) as { url?: string; number?: number; branch?: string }) : {}
  return (
    <div className="space-y-2">
      {blocked && ['ready', 'held', 'landed'].includes(p.state) && (
        <p className="rounded-md bg-amber-50 dark:bg-amber-950/60 px-3 py-2 text-sm text-amber-900 dark:text-amber-200">Delivery is blocked: {p.write!.why}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {(p.state === 'ready' || p.state === 'held') && (
          p.state === 'held'
            ? <Confirmed label="Deliver anyway" word={p.id} onConfirm={() => approve.mutate()} busy={busy || blocked} />
            : <Button variant="primary" onClick={() => approve.mutate()} disabled={busy || blocked}>{approve.isPending ? 'Delivering…' : `Approve → ${p.delivery}`}</Button>
        )}
        {p.state === 'submitted' && p.delivery !== 'pr' && <Confirmed label="Merge (fast-forward)" word={p.id} onConfirm={() => merge.mutate()} busy={busy} />}
        {p.state === 'submitted' && ref.url && <a className="text-sm underline" href={ref.url} target="_blank" rel="noreferrer">Open PR #{ref.number} ↗</a>}
        {p.state === 'landed' && p.delivery === 'push' && <Confirmed label="Revert" variant="danger" word={p.id} onConfirm={() => revert.mutate()} busy={busy || blocked} />}
        {['ready', 'held', 'submitted'].includes(p.state) && !rejecting && <Button variant="danger" onClick={() => setRejecting(true)} disabled={busy}>{p.state === 'submitted' ? 'Close' : 'Reject'}…</Button>}
      </div>
      {rejecting && (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); reject.mutate(); setRejecting(false) }}>
          <input autoFocus className={inputCls} placeholder="Why? (recorded beside what the model proposed)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Button type="submit" variant="danger">{p.state === 'submitted' ? 'Close and delete branch' : 'Reject'}</Button>
          <Button type="button" variant="ghost" onClick={() => setRejecting(false)}>Cancel</Button>
        </form>
      )}
      <ErrorNote error={approve.error || reject.error || merge.error || revert.error} />
    </div>
  )
}

export default function Proposal() {
  const id = useParams().id!
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['proposal', id], queryFn: () => api.proposal(id), refetchInterval: (d) => (['drafting', 'validating'].includes(d.state.data?.state ?? '') ? 4000 : false) })
  const p = q.data
  if (q.error) return <ErrorNote error={q.error} />
  if (!p) return <p className="text-sm text-stone-500">Loading…</p>
  const lines = (p.summary ?? '').split('\n')
  return (
    <div className="space-y-4 max-w-5xl">
      <div>
        <Link to={`/repos/${encodeURIComponent(p.repo_key!)}`} className="text-xs text-stone-500 hover:underline">← {p.repo_key}</Link>
        <h1 className="text-xl font-semibold">{lines[0] || `${p.check_kind} proposal`}</h1>
        <div className="mt-1 flex flex-wrap gap-2 items-center text-xs text-stone-500">
          <Badge tone={stateTone(p.state)}>{p.state}</Badge>
          <Badge>{p.check_kind}</Badge>
          <Badge>delivery: {p.delivery}</Badge>
          {p.sensitive ? <Badge tone="red">sensitive</Badge> : null}
          <code>{p.branch}</code>
          <span><Sha sha={p.base_sha} />..<Sha sha={p.head_sha} /></span>
          <span>updated {ago(p.updated_at)}</span>
        </div>
      </div>
      <Card title="Decision"><ProposalActions p={p} onDone={() => { void qc.invalidateQueries({ queryKey: ['proposal', id] }); void qc.invalidateQueries({ queryKey: ['activity'] }) }} />
        {p.error && <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">{p.error}</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Findings addressed">
          <ul className="space-y-1.5 text-sm">
            {p.findings?.map((f) => (
              <li key={f.id} className="flex flex-wrap gap-1.5 items-center"><Badge tone={severityTone(f.severity)}>{f.severity}</Badge>{f.title}<code className="text-xs text-stone-500">{f.anchor}</code><Badge tone={stateTone(f.state)}>{f.state}</Badge></li>
            ))}
          </ul>
        </Card>
        <Card title={p.validation ? (p.validation.ok ? 'Validation ✓ passed' : 'Validation ✗ failed') : 'Validation'}>
          {p.validation ? (
            <div className="space-y-2">
              <Markdown text={p.validation.verdict} />
              {p.validation.remaining.map((x, i) => <p key={i} className="text-sm text-red-700 dark:text-red-300">• {x.title} <code className="text-xs">{x.anchor}</code></p>)}
              <Link className="text-xs underline" to={`/rounds/${p.validation.round}`}>validation session</Link>
            </div>
          ) : <p className="text-sm text-stone-500">{p.state === 'drafting' ? 'The fix is being written.' : 'Not validated yet.'}</p>}
        </Card>
      </div>
      {lines.length > 1 && <Card title="Description (from the fixing session)"><Markdown text={lines.slice(1).join('\n')} /></Card>}
      {p.patch && <Card title="Patch"><Diff patch={p.patch} /></Card>}
    </div>
  )
}
