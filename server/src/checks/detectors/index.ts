import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordedFinding } from '../../sessions/session.js'

/**
 * Deterministic detectors, run by Lamplighter itself on the worktree. No model, no session, no
 * budget. v1 speaks the npm ecosystem; other lockfiles are reported as unsupported, not as clean.
 */

export interface DetectorResult {
  findings: RecordedFinding[]
  notes: string[]
}

type Fetch = typeof fetch

interface LockPackage {
  version?: string
  dev?: boolean
}

export function lockPackages(lock: { packages?: Record<string, LockPackage>; dependencies?: Record<string, LockPackage> }): Map<string, string> {
  const out = new Map<string, string>()
  if (lock.packages) {
    for (const [path, p] of Object.entries(lock.packages)) {
      if (!path || !p.version) continue
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length)
      out.set(`${name}@${p.version}`, name)
    }
  } else if (lock.dependencies) {
    for (const [name, p] of Object.entries(lock.dependencies)) if (p.version) out.set(`${name}@${p.version}`, name)
  }
  return out
}

function severityOf(v: { database_specific?: { severity?: string } }): RecordedFinding['severity'] {
  const s = v.database_specific?.severity?.toUpperCase()
  if (s === 'CRITICAL') return 'critical'
  if (s === 'HIGH') return 'major'
  return 'minor'
}

export async function osv(worktree: string, fetchImpl: Fetch = fetch): Promise<DetectorResult> {
  const lockFile = join(worktree, 'package-lock.json')
  const notes: string[] = []
  for (const other of ['yarn.lock', 'pnpm-lock.yaml', 'go.sum', 'poetry.lock', 'Cargo.lock', 'requirements.txt']) {
    if (existsSync(join(worktree, other))) notes.push(`${other} present — not scanned in v1 (npm package-lock.json only)`)
  }
  if (!existsSync(lockFile)) return { findings: [], notes: [...notes, 'no package-lock.json'] }
  const pkgs = lockPackages(JSON.parse(readFileSync(lockFile, 'utf8')))
  const entries = [...pkgs.entries()]
  const findings: RecordedFinding[] = []
  for (let i = 0; i < entries.length; i += 500) {
    const batch = entries.slice(i, i + 500)
    const res = await fetchImpl('https://api.osv.dev/v1/querybatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ queries: batch.map(([id, name]) => ({ package: { name, ecosystem: 'npm' }, version: id.slice(name.length + 1) })) }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`OSV querybatch → ${res.status}`)
    const body = (await res.json()) as { results: { vulns?: { id: string }[] }[] }
    for (let j = 0; j < batch.length; j++) {
      const vulns = body.results[j]?.vulns ?? []
      if (!vulns.length) continue
      const [id] = batch[j]!
      // Details for the headline; at most a few lookups per package.
      const details = await Promise.all(
        vulns.slice(0, 5).map(async (v) => {
          try {
            const r = await fetchImpl(`https://api.osv.dev/v1/vulns/${v.id}`, { signal: AbortSignal.timeout(15_000) })
            return (await r.json()) as { id: string; summary?: string; aliases?: string[]; database_specific?: { severity?: string } }
          } catch {
            return { id: v.id }
          }
        }),
      )
      const worst = details.map(severityOf).sort((a, b) => ['critical', 'major', 'minor'].indexOf(a) - ['critical', 'major', 'minor'].indexOf(b))[0] ?? 'minor'
      findings.push({
        category: 'vulnerable-dependency',
        anchor: `npm:${id}`,
        title: `${id}: ${vulns.length} known vulnerabilit${vulns.length === 1 ? 'y' : 'ies'}`,
        body: details.map((d) => `- **${d.id}**${d.aliases?.length ? ` (${d.aliases.join(', ')})` : ''}: ${d.summary ?? ''} — https://osv.dev/vulnerability/${d.id}`).join('\n'),
        severity: worst,
      })
    }
  }
  return { findings, notes: [...notes, `${entries.length} packages checked against OSV`] }
}

/** Major/minor only — patch drift is noise. Semver-ish compare of x.y.z, ignoring ranges' operators. */
export function drift(range: string, latest: string): 'major' | 'minor' | null {
  const cur = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(range)
  const lat = /(\d+)\.(\d+)\.(\d+)/.exec(latest)
  if (!cur || !lat) return null
  if (Number(lat[1]) > Number(cur[1])) return 'major'
  if (Number(lat[1]) === Number(cur[1]) && Number(lat[2]) > Number(cur[2])) return 'minor'
  return null
}

export async function npmOutdated(worktree: string, fetchImpl: Fetch = fetch): Promise<DetectorResult> {
  const pkgFile = join(worktree, 'package.json')
  if (!existsSync(pkgFile)) return { findings: [], notes: ['no package.json'] }
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as Record<string, Record<string, string> | undefined>
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  const findings: RecordedFinding[] = []
  const names = Object.keys(deps).filter((n) => /^\^|~|\d/.test(deps[n]!))
  await Promise.all(
    names.map(async (name) => {
      try {
        const r = await fetchImpl(`https://registry.npmjs.org/${name.replace('/', '%2F')}/latest`, { signal: AbortSignal.timeout(15_000) })
        if (!r.ok) return
        const latest = ((await r.json()) as { version: string }).version
        const d = drift(deps[name]!, latest)
        if (!d) return
        findings.push({
          category: d === 'major' ? 'outdated-major' : 'outdated-minor',
          anchor: `npm:${name}`,
          title: `${name} ${deps[name]} → ${latest}`,
          body: `package.json asks for \`${deps[name]}\`; the registry's latest is \`${latest}\` (${d} behind).`,
          severity: d === 'major' ? 'major' : 'minor',
        })
      } catch {
        /* one registry hiccup is not a finding */
      }
    }),
  )
  findings.sort((a, b) => a.anchor.localeCompare(b.anchor))
  return { findings, notes: [`${names.length} direct dependencies compared with the npm registry`] }
}

export async function runDetectors(names: string[], worktree: string): Promise<DetectorResult> {
  const all: DetectorResult = { findings: [], notes: [] }
  for (const n of names) {
    const r = n === 'osv' ? await osv(worktree) : n === 'npm-outdated' ? await npmOutdated(worktree) : { findings: [], notes: [`unknown detector ${n}`] }
    all.findings.push(...r.findings)
    all.notes.push(...r.notes)
  }
  return all
}
