import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, api, type ActivityItem } from '../api'
import { Badge, Button, Card, Empty, ErrorNote, inputCls } from '../components/ui'
import { ProposalActions } from './Proposal'

const KIND: Record<ActivityItem['kind'], { label: string; tone: 'amber' | 'blue' | 'green' | 'red' | 'violet' | 'stone' }> = {
  'proposal-ready': { label: 'awaiting approval', tone: 'amber' },
  'branch-open': { label: 'branch to review', tone: 'blue' },
  'pr-open': { label: 'pull request open', tone: 'blue' },
  pushed: { label: 'pushed', tone: 'green' },
  held: { label: 'held (sensitive)', tone: 'red' },
  report: { label: 'report to read', tone: 'violet' },
  alert: { label: 'alert', tone: 'red' },
}

function Item({ item }: { item: ActivityItem }) {
  const qc = useQueryClient()
  const isProposal = ['proposal-ready', 'branch-open', 'pr-open', 'pushed', 'held'].includes(item.kind)
  const p = useQuery({ queryKey: ['proposal', item.ref_id], queryFn: () => api.proposal(item.ref_id!), enabled: isProposal && item.state === 'open' && !!item.ref_id })
  const [note, setNote] = useState('')
  const ack = useMutation({ mutationFn: () => api.resolveItem(item.id, note || undefined), onSuccess: () => void qc.invalidateQueries({ queryKey: ['activity'] }) })
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['activity'] })
    void qc.invalidateQueries({ queryKey: ['overview'] })
    void qc.invalidateQueries({ queryKey: ['proposal', item.ref_id] })
  }
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={KIND[item.kind].tone}>{KIND[item.kind].label}</Badge>
        {item.sensitive ? <Badge tone="red">sensitive</Badge> : null}
        {item.repo_key && <Link className="text-xs text-stone-500 hover:underline" to={`/repos/${encodeURIComponent(item.repo_key)}`}>{item.repo_key}</Link>}
        <span className="text-xs text-stone-400">{ago(item.created_at)}</span>
        {item.state === 'resolved' && <Badge>{item.resolution}{item.reason ? `: ${item.reason}` : ''}</Badge>}
      </div>
      <div className="mt-1 font-medium text-sm">
        {isProposal && item.ref_id ? <Link className="hover:underline" to={`/proposals/${item.ref_id}`}>{item.title}</Link> : item.kind === 'report' && item.ref_id ? <Link className="hover:underline" to={`/rounds/${item.ref_id}`}>{item.title}</Link> : item.title}
        {item.url && <a className="ml-2 text-xs underline" href={item.url} target="_blank" rel="noreferrer">open ↗</a>}
      </div>
      {item.body && <p className="text-xs text-stone-600 dark:text-stone-400 mt-0.5 whitespace-pre-wrap">{item.body}</p>}
      {item.state === 'open' && (
        <div className="mt-2 space-y-2">
          {isProposal && p.data && <ProposalActions p={p.data} onDone={done} />}
          {(item.kind === 'report' || item.kind === 'alert' || item.kind === 'pushed') && (
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); ack.mutate() }}>
              <input className={`${inputCls} !w-72 text-xs`} placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Button type="submit">{item.kind === 'report' ? 'Mark read' : 'Acknowledge'}</Button>
            </form>
          )}
        </div>
      )}
    </li>
  )
}

export default function Activity() {
  const [tab, setTab] = useState<'open' | 'resolved'>('open')
  const q = useQuery({ queryKey: ['activity', tab], queryFn: () => api.activity(tab), refetchInterval: 8000 })
  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Activity</h1>
        <div className="flex gap-1 rounded-lg bg-stone-200/60 dark:bg-stone-800 p-0.5 text-sm">
          {(['open', 'resolved'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 ${tab === t ? 'bg-white dark:bg-stone-700 shadow-sm font-medium' : 'text-stone-600 dark:text-stone-400'}`}>{t === 'open' ? 'Inbox' : 'Resolved'}</button>
          ))}
        </div>
      </div>
      <ErrorNote error={q.error} />
      <Card title={tab === 'open' ? 'Awaiting you' : 'Resolved'}>
        {q.data?.items.length === 0 ? <Empty>{tab === 'open' ? 'Nothing waits for you.' : 'Nothing resolved yet.'}</Empty> : (
          <ul className="divide-y divide-stone-100 dark:divide-stone-800 -my-3">{q.data?.items.map((i) => <Item key={i.id} item={i} />)}</ul>
        )}
      </Card>
      <Card title="Log">
        <ul className="text-xs space-y-1 font-mono">
          {q.data?.events.map((e) => (
            <li key={e.id} className={e.level === 'error' ? 'text-red-600' : e.level === 'warn' ? 'text-amber-700 dark:text-amber-400' : 'text-stone-600 dark:text-stone-400'}>
              {e.at.slice(5, 19).replace('T', ' ')} <span className="font-semibold">{e.code}</span> {e.repo_key && <Link className="underline" to={`/repos/${encodeURIComponent(e.repo_key)}`}>{e.repo_key}</Link>} — {e.message}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
