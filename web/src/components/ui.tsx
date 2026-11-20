import type { ButtonHTMLAttributes, ReactNode } from 'react'
import type { LampState } from '../api'
import { renderMarkdown } from '../markdown'

export function Button({ variant = 'default', className = '', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'danger' | 'ghost' }) {
  const styles = {
    default: 'bg-white dark:bg-stone-800 border border-stone-300 dark:border-stone-700 hover:bg-stone-100 dark:hover:bg-stone-700',
    primary: 'bg-amber-500 hover:bg-amber-600 text-stone-950 border border-amber-600',
    danger: 'bg-white dark:bg-stone-800 border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950',
    ghost: 'hover:bg-stone-200/60 dark:hover:bg-stone-800',
  }[variant]
  return <button {...p} className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${styles} ${className}`} />
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900 ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-stone-200 dark:border-stone-800 px-4 py-2.5">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  )
}

export function Badge({ children, tone = 'stone' }: { children: ReactNode; tone?: 'stone' | 'amber' | 'red' | 'green' | 'blue' | 'violet' }) {
  const t = {
    stone: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
    amber: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
    red: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
    green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
    blue: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
    violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  }[tone]
  return <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${t}`}>{children}</span>
}

export function severityTone(s: string) {
  return s === 'critical' ? 'red' : s === 'major' ? 'amber' : 'stone'
}

export function stateTone(s: string): 'stone' | 'amber' | 'red' | 'green' | 'blue' | 'violet' {
  if (['open', 'running', 'validating', 'drafting', 'queued'].includes(s)) return 'amber'
  if (['failed', 'blocked', 'stale'].includes(s)) return 'red'
  if (['fixed', 'landed', 'done', 'ready', 'merged'].includes(s)) return 'green'
  if (['proposed', 'submitted', 'held'].includes(s)) return 'blue'
  if (['dismissed', 'rejected', 'reverted'].includes(s)) return 'violet'
  return 'stone'
}

const LAMP: Record<LampState, { cls: string; label: string }> = {
  lit: { cls: 'bg-emerald-500 shadow-[0_0_8px_2px_rgba(16,185,129,0.55)]', label: 'lit — clean as of the last round' },
  dim: { cls: 'bg-amber-700/70 dark:bg-amber-800', label: 'dim — open findings' },
  out: { cls: 'bg-red-500', label: 'out — last round blocked or failed' },
  unlit: { cls: 'bg-stone-300 dark:bg-stone-700', label: 'unlit — never run' },
  off: { cls: 'border border-dashed border-stone-300 dark:border-stone-700', label: 'off — check disabled' },
}

export function LampDot({ state, count, title }: { state: LampState; count?: number; title?: string }) {
  return (
    <span title={`${title ? `${title}: ` : ''}${LAMP[state].label}${count ? ` (${count})` : ''}`} className="inline-flex items-center gap-1">
      <span className={`inline-block h-3 w-3 rounded-full ${LAMP[state].cls}`} />
      {count ? <span className="text-[11px] text-stone-500 tabular-nums">{count}</span> : null}
    </span>
  )
}

export function Markdown({ text }: { text: string }) {
  return <div className="prose-ll" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null
  return <p className="rounded-md bg-red-50 dark:bg-red-950/60 px-3 py-2 text-sm text-red-700 dark:text-red-300">{(error as Error).message}</p>
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-stone-600 dark:text-stone-400">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-stone-500">{hint}</span>}
    </label>
  )
}

export const inputCls =
  'w-full rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-amber-400/60'

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-stone-500">{children}</p>
}

export function Sha({ sha }: { sha: string | null | undefined }) {
  return sha ? <code className="font-mono text-xs text-stone-500">{sha.slice(0, 8)}</code> : <span className="text-stone-400">—</span>
}
