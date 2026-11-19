import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, api } from '../api'
import { Badge, Button, Card, Empty, ErrorNote, Field, LampDot, inputCls } from '../components/ui'

const SHORT: Record<string, string> = {
  docs: 'docs', cve: 'cve', deps: 'deps', 'dead-code': 'dead', refactor: 'refac', quality: 'qual', patterns: 'patt', architecture: 'arch', security: 'sec',
}

export default function Repos() {
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos, refetchInterval: 10_000 })
  const [adding, setAdding] = useState(false)
  const kinds = Object.keys(repos.data?.[0]?.lamps ?? SHORT)
  return (
    <div className="space-y-4 max-w-6xl">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Repositories</h1>
        <Button variant="primary" onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : 'Add repositories'}</Button>
      </div>
      {adding && <AddRepo onDone={() => setAdding(false)} />}
      <ErrorNote error={repos.error} />
      <Card>
        {repos.data?.length === 0 ? (
          <Empty>No repositories yet. Add a forge in Settings, then add repositories here.</Empty>
        ) : (
          <div className="overflow-x-auto -m-4">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-stone-500 border-b border-stone-200 dark:border-stone-800">
                  <th className="px-4 py-2 font-medium">Repository</th>
                  <th className="px-2 py-2 font-medium">Line</th>
                  {kinds.map((k) => (
                    <th key={k} className="px-1.5 py-2 font-medium text-center" title={k}>{SHORT[k] ?? k}</th>
                  ))}
                  <th className="px-4 py-2 font-medium">Fetched</th>
                </tr>
              </thead>
              <tbody>
                {repos.data?.map((r) => (
                  <tr key={r.key} className="border-b last:border-0 border-stone-100 dark:border-stone-800/70 hover:bg-stone-50 dark:hover:bg-stone-800/40">
                    <td className="px-4 py-2">
                      <Link to={`/repos/${encodeURIComponent(r.key)}`} className="font-medium hover:underline">{r.owner ? `${r.owner}/` : ''}{r.name}</Link>
                      <div className="flex gap-1 mt-0.5">
                        <Badge>{r.forge_id}</Badge>
                        <Badge tone={r.visibility === 'public' ? 'blue' : 'stone'}>{r.visibility}</Badge>
                        {r.group_id !== 'default' && <Badge tone="violet">{r.group_id}</Badge>}
                      </div>
                    </td>
                    <td className="px-2 py-2 text-xs"><code>{r.line}</code> <span className="text-stone-400 font-mono">{r.last_head?.slice(0, 7)}</span></td>
                    {kinds.map((k) => (
                      <td key={k} className="px-1.5 py-2 text-center"><LampDot state={r.lamps[k]?.lamp ?? 'unlit'} count={r.lamps[k]?.open} title={k} /></td>
                    ))}
                    <td className="px-4 py-2 text-xs text-stone-500">{r.fetch_error ? <span className="text-red-600" title={r.fetch_error}>fetch failed</span> : ago(r.last_fetch_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-xs text-stone-500 flex flex-wrap gap-4">
        <span><LampDot state="lit" /> lit: clean</span>
        <span><LampDot state="dim" /> dim: open findings</span>
        <span><LampDot state="out" /> out: last round blocked/failed</span>
        <span><LampDot state="unlit" /> never run</span>
        <span><LampDot state="off" /> disabled</span>
      </p>
    </div>
  )
}

function AddRepo({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: api.settings })
  const forges = settings.data?.forges ?? []
  const [forge, setForge] = useState('')
  const [owner, setOwner] = useState('')
  const [name, setName] = useState('')
  const [line, setLine] = useState('')
  const [remote, setRemote] = useState('')
  const [group, setGroup] = useState('default')
  const [visibility, setVisibility] = useState('')
  const f = forges.find((x) => x.id === (forge || forges[0]?.id))
  const add = useMutation({
    mutationFn: (b: Record<string, unknown>) => api.addRepo(b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['repos'] })
      setName('')
    },
  })
  const discover = useMutation({ mutationFn: () => api.discover(f!.id, owner) })
  if (!forges.length) return <Card><Empty>Configure a forge first, in Settings → Forges.</Empty></Card>
  return (
    <Card title="Add repositories" actions={<Button variant="ghost" onClick={onDone}>Done</Button>}>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Forge">
          <select className={inputCls} value={f?.id} onChange={(e) => setForge(e.target.value)}>
            {forges.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.kind})</option>)}
          </select>
        </Field>
        <Field label={f?.kind === 'git' ? 'Owner / path segment (optional)' : 'Owner (user or org)'}>
          <input className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="Repository name">
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Line (branch)" hint={f?.kind === 'git' ? 'default main' : 'default: the forge’s default branch'}>
          <input className={inputCls} value={line} onChange={(e) => setLine(e.target.value)} />
        </Field>
        <Field label="Group">
          <select className={inputCls} value={group} onChange={(e) => setGroup(e.target.value)}>
            {settings.data?.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </Field>
        <Field label="Visibility" hint={f?.kind === 'git' ? 'bare git cannot say — default private' : 'default: read from the forge'}>
          <select className={inputCls} value={visibility} onChange={(e) => setVisibility(e.target.value)}>
            <option value="">{f?.kind === 'git' ? 'private' : 'from the forge'}</option>
            <option value="public">public</option>
            <option value="private">private</option>
          </select>
        </Field>
        {f?.kind === 'git' && (
          <Field label="Full remote URL (optional)" hint="overrides forge base URL + name">
            <input className={inputCls} value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="ssh://git@host/repo.git" />
          </Field>
        )}
      </div>
      <div className="mt-3 flex gap-2">
        <Button
          variant="primary"
          disabled={!name || add.isPending}
          onClick={() => add.mutate({ forge_id: f!.id, owner: owner || undefined, name, line: line || undefined, group_id: group, visibility: visibility || undefined, remote_url: remote || undefined })}
        >
          {add.isPending ? 'Adding…' : 'Add'}
        </Button>
        {f?.kind !== 'git' && (
          <Button disabled={!owner || discover.isPending} onClick={() => discover.mutate()}>{discover.isPending ? 'Listing…' : `List ${owner || 'owner'}’s repositories`}</Button>
        )}
      </div>
      <ErrorNote error={add.error || discover.error} />
      {add.isSuccess && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Added {add.data.key}. Its first fetch is running.</p>}
      {discover.data && (
        <ul className="mt-3 divide-y divide-stone-100 dark:divide-stone-800 text-sm">
          {discover.data.map((r) => (
            <li key={r.name} className="flex items-center justify-between py-1.5">
              <span>{r.owner}/{r.name} <Badge tone={r.visibility === 'public' ? 'blue' : 'stone'}>{r.visibility}</Badge></span>
              {r.enrolled ? <Badge tone="green">monitored</Badge> : <Button onClick={() => add.mutate({ forge_id: f!.id, owner: r.owner, name: r.name, group_id: group })}>Add</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
