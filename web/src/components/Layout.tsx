import { useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { api } from '../api'

const NAV = [
  { to: '/', label: 'Chat', icon: '💬', end: true },
  { to: '/repos', label: 'Repos', icon: '🏮' },
  { to: '/activity', label: 'Activity', icon: '📥' },
  { to: '/settings', label: 'Settings', icon: '⚙️' },
]

export default function Layout({ children }: { children: ReactNode }) {
  const overview = useQuery({ queryKey: ['overview'], queryFn: api.overview, refetchInterval: 10_000 })
  const o = overview.data
  const busy = (o?.schedule.running.length ?? 0) + (o?.schedule.queued.length ?? 0)
  return (
    <div className="min-h-screen md:flex">
      <aside className="md:w-56 md:shrink-0 md:border-r border-b md:border-b-0 border-stone-200 dark:border-stone-800 bg-stone-100/60 dark:bg-stone-900/60">
        <div className="flex items-center gap-2 px-4 py-4">
          <img src="/icon.svg" alt="" className="h-7 w-7" />
          <div>
            <div className="font-semibold leading-tight">Lamplighter</div>
            <div className="text-[11px] text-stone-500">keeps the repos lit</div>
          </div>
        </div>
        <nav className="flex md:flex-col gap-1 px-2 pb-2 overflow-x-auto">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap ${isActive ? 'bg-white dark:bg-stone-800 font-medium shadow-sm' : 'text-stone-600 dark:text-stone-400 hover:bg-white/60 dark:hover:bg-stone-800/60'}`
              }
            >
              <span aria-hidden>{n.icon}</span>
              {n.label}
              {n.to === '/activity' && o?.inbox ? <span className="ml-auto rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-stone-950">{o.inbox}</span> : null}
            </NavLink>
          ))}
        </nav>
        <div className="hidden md:block px-4 py-3 text-[11px] text-stone-500 space-y-1">
          {overview.error ? <div className="text-red-600">API unreachable</div> : null}
          {o && (
            <>
              <div>{o.repos} repos · {o.open_findings} open findings{o.not_now ? ` · ${o.not_now} not now` : ''}</div>
              <div>{busy ? `${o.schedule.running.length} running · ${o.schedule.queued.length} queued` : 'idle'}</div>
              <div>sessions this hour {o.schedule.budget.sessions_this_hour}/{o.schedule.budget.sessions_per_hour}</div>
              <div className="truncate" title={o.inference.url}>{o.inference.driver}</div>
            </>
          )}
        </div>
      </aside>
      <main className="flex-1 min-w-0 p-4 md:p-6">{children}</main>
    </div>
  )
}
