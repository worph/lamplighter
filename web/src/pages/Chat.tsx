import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { api, type ChatMessage } from '../api'
import { Button, ErrorNote, Markdown, inputCls } from '../components/ui'

function Pending({ m, onDone }: { m: ChatMessage; onDone: () => void }) {
  const p = JSON.parse(m.pending!) as { tool: string; input: unknown; word: string; done?: boolean }
  const [typed, setTyped] = useState('')
  const confirm = useMutation({ mutationFn: () => api.confirmChat(m.id, typed), onSuccess: onDone })
  if (p.done) return <p className="mt-2 text-xs text-stone-500">Confirmed: {p.tool}</p>
  return (
    <div className="mt-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3">
      <p className="text-xs">Decisive action <code>{p.tool}</code> <code className="text-[11px]">{JSON.stringify(p.input)}</code></p>
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); confirm.mutate() }}>
        <input className={`${inputCls} !w-64 font-mono text-xs`} placeholder={`type ${p.word} to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} />
        <Button type="submit" variant="primary" disabled={typed !== p.word || confirm.isPending}>Confirm</Button>
      </form>
      <ErrorNote error={confirm.error} />
    </div>
  )
}

export default function Chat() {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['chat'], queryFn: api.chat })
  const [text, setText] = useState('')
  const [draft, setDraft] = useState<string>()
  const end = useRef<HTMLDivElement>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['chat'] })
  const send = useMutation({
    mutationFn: (m: string) => api.sendChat(m),
    onMutate: (m) => { setDraft(m); setText('') },
    onSettled: () => { setDraft(undefined); refresh() },
  })
  const reset = useMutation({ mutationFn: api.newChat, onSuccess: refresh })
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" })
  }, [q.data, draft])
  const msgs = q.data?.messages ?? []
  return (
    <div className="max-w-3xl mx-auto flex flex-col h-[calc(100vh-3rem)]">
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-xl font-semibold">Chat</h1>
        <Button variant="ghost" onClick={() => reset.mutate()}>New conversation</Button>
      </div>
      <div className="flex-1 overflow-y-auto space-y-3 pb-4">
        {msgs.length === 0 && !draft && (
          <div className="rounded-xl border border-dashed border-stone-300 dark:border-stone-700 p-6 text-sm text-stone-600 dark:text-stone-400">
            <p className="font-medium text-stone-800 dark:text-stone-200 mb-2">Ask about the fleet, or tell Lamplighter what to do.</p>
            <ul className="space-y-1">
              {['Which repositories have open security findings?', 'Run a docs round on every repo', 'Why was the last dead-code proposal rejected?', 'Arm the quality check for the yundera group'].map((s) => (
                <li key={s}><button className="underline hover:text-amber-700" onClick={() => setText(s)}>{s}</button></li>
              ))}
            </ul>
          </div>
        )}
        {msgs.map((m) =>
          m.role === 'tool' ? (
            <details key={m.id} className="text-xs text-stone-500 ml-4">
              <summary className="cursor-pointer">ran <code>{m.tool}</code></summary>
              <pre className="mt-1 whitespace-pre-wrap max-h-64 overflow-y-auto bg-stone-100 dark:bg-stone-900 rounded p-2">{m.content}</pre>
            </details>
          ) : (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : ''}>
              <div className={`rounded-xl px-4 py-2.5 max-w-[85%] ${m.role === 'user' ? 'bg-amber-100 dark:bg-amber-950/60' : 'bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800'}`}>
                {m.role === 'user' ? <p className="text-sm whitespace-pre-wrap">{m.content}</p> : <Markdown text={m.content} />}
                {m.pending && <Pending m={m} onDone={refresh} />}
              </div>
            </div>
          ),
        )}
        {draft && (
          <>
            <div className="flex justify-end"><div className="rounded-xl px-4 py-2.5 bg-amber-100 dark:bg-amber-950/60 text-sm">{draft}</div></div>
            <p className="text-xs text-stone-500 animate-pulse">Lamplighter is thinking…</p>
          </>
        )}
        <div ref={end} />
      </div>
      <ErrorNote error={send.error} />
      <form className="flex gap-2 pt-2 border-t border-stone-200 dark:border-stone-800" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate(text.trim()) }}>
        <textarea
          className={`${inputCls} min-h-[44px] max-h-40`}
          rows={1}
          value={text}
          placeholder="Message Lamplighter…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (text.trim()) send.mutate(text.trim()) } }}
        />
        <Button type="submit" variant="primary" disabled={send.isPending || !text.trim()}>Send</Button>
      </form>
    </div>
  )
}
