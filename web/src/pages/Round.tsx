import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ago, api } from '../api'
import { Badge, Card, ErrorNote, Markdown, Sha, stateTone } from '../components/ui'

export default function Round() {
  const id = useParams().id!
  const q = useQuery({ queryKey: ['round', id], queryFn: () => api.round(id), refetchInterval: (d) => (d.state.data?.status === 'running' ? 4000 : false) })
  const r = q.data
  if (q.error) return <ErrorNote error={q.error} />
  if (!r) return <p className="text-sm text-stone-500">Loading…</p>
  const usage = r.usage_json ? (JSON.parse(r.usage_json) as { tokens_in?: number; tokens_out?: number; wall_ms?: number; cost_usd?: number }) : undefined
  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <Link to={`/repos/${encodeURIComponent(r.repo_key!)}`} className="text-xs text-stone-500 hover:underline">← {r.repo_key}</Link>
        <h1 className="text-xl font-semibold">{r.kind === 'arbitrate' ? 'admission · arbiter session' : `${r.check_kind} · ${r.kind === 'round' ? `${r.scope} round` : r.kind === 'author' ? 'fixing session' : 'validation session'}`}</h1>
        <div className="mt-1 flex flex-wrap gap-2 items-center text-xs text-stone-500">
          <Badge tone={stateTone(r.status)}>{r.status}</Badge>
          <span>{r.trigger}</span>
          <span>{r.base_sha ? <><Sha sha={r.base_sha} />..</> : null}<Sha sha={r.head_sha} /></span>
          <span>started {ago(r.started_at)}</span>
          {usage && <span>{Math.round((usage.wall_ms ?? 0) / 1000)}s{usage.tokens_out ? ` · ${usage.tokens_in ?? 0}→${usage.tokens_out} tokens` : ''}{usage.cost_usd ? ` · $${usage.cost_usd.toFixed(3)}` : ''}</span>}
          {r.proposal_id && <Link className="underline" to={`/proposals/${r.proposal_id}`}>proposal {r.proposal_id}</Link>}
        </div>
      </div>
      {r.error && <Card title="Why it did not complete"><p className="text-sm text-red-700 dark:text-red-300 whitespace-pre-wrap">{r.error}</p></Card>}
      {r.status === 'running' && <Card><p className="text-sm text-stone-500">The session is running. This page refreshes on its own.</p></Card>}
      {r.report && <Card title="Report"><Markdown text={r.report} /></Card>}
    </div>
  )
}
