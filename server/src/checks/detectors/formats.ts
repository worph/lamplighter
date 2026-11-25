import type { RecordedFinding } from '../../sessions/session.js'
import type { DetectorResult } from './index.js'

/**
 * Scanner output → findings. SARIF is the common format (most scanners emit it), so a new
 * scanner is a line in a check file, not code (architecture §5). osv-scanner's JSON is read
 * natively to keep the built-in `osv` detector's anchors (`npm:<name>@<version>`), so findings
 * raised before the sandbox keep their fingerprints.
 */

const TITLE_MAX = 200
const BODY_MAX = 4000

function title(s: string): string {
  const line = s.split('\n')[0]!.trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line
}

/** Repo-relative: scanners report `/work/repo/x` or `file:///work/repo/x`. */
function repoPath(uri: string | undefined, root: string): string {
  if (!uri) return '(repository)'
  const p = uri.replace(/^file:\/\//, '')
  return p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p.replace(/^\.\//, '')
}

interface SarifResult {
  ruleId?: string
  level?: string
  message?: { text?: string }
  locations?: { physicalLocation?: { artifactLocation?: { uri?: string }; region?: { startLine?: number } } }[]
}

const SARIF_SEVERITY: Record<string, RecordedFinding['severity']> = { error: 'major', warning: 'minor', note: 'minor', none: 'minor' }

/**
 * SARIF 2.1 results. The anchor is `path#rule`, without the line, so a finding survives code moving
 * around it. Snippets are never copied: a secret scanner's snippet is the secret.
 */
export function fromSarif(text: string, o: { category: string; root: string; tool: string }): DetectorResult {
  let doc: { runs?: { results?: SarifResult[] }[] }
  try {
    doc = JSON.parse(text)
  } catch {
    return { findings: [], notes: [`${o.tool}: output is not SARIF JSON`] }
  }
  const findings: RecordedFinding[] = []
  const seen = new Set<string>()
  for (const run of doc.runs ?? []) {
    for (const r of run.results ?? []) {
      const loc = r.locations?.[0]?.physicalLocation
      const path = repoPath(loc?.artifactLocation?.uri, o.root)
      const rule = r.ruleId ?? 'finding'
      const anchor = `${path}#${rule}`
      if (seen.has(anchor)) continue
      seen.add(anchor)
      const line = loc?.region?.startLine
      const message = (r.message?.text ?? rule).replaceAll(`${o.root}/`, '')
      findings.push({
        category: o.category,
        anchor,
        title: title(`${rule} in ${path}`),
        body: `${o.tool}: ${message}${line ? ` (line ${line})` : ''}`.slice(0, BODY_MAX),
        severity: SARIF_SEVERITY[r.level ?? 'warning'] ?? 'minor',
      })
    }
  }
  return { findings, notes: [`${o.tool}: ${findings.length} result(s)`] }
}

interface OsvPackage {
  package: { name: string; version: string; ecosystem: string }
  groups?: { ids: string[]; aliases?: string[]; max_severity?: string }[]
  vulnerabilities?: { id: string; summary?: string; aliases?: string[]; database_specific?: { severity?: string } }[]
}

function osvSeverity(p: OsvPackage): RecordedFinding['severity'] {
  const scores = (p.groups ?? []).map((g) => Number(g.max_severity)).filter((n) => Number.isFinite(n))
  const named = (p.vulnerabilities ?? []).map((v) => v.database_specific?.severity?.toUpperCase())
  const top = scores.length ? Math.max(...scores) : 0
  if (top >= 9 || named.includes('CRITICAL')) return 'critical'
  if (top >= 7 || named.includes('HIGH')) return 'major'
  return 'minor'
}

/** One finding per vulnerable package version, as the built-in `osv` detector raises them. */
export function fromOsvJson(text: string, o: { category: string; tool: string }): DetectorResult {
  // osv-scanner exits 128 and prints nothing when the repository has no lockfile or manifest.
  if (!text.trim()) return { findings: [], notes: [`${o.tool}: no package sources found`] }
  let doc: { results?: { source?: { path?: string }; packages?: OsvPackage[] }[] }
  try {
    doc = JSON.parse(text)
  } catch {
    return { findings: [], notes: [`${o.tool}: output is not JSON`] }
  }
  const findings: RecordedFinding[] = []
  const sources: string[] = []
  const seen = new Set<string>()
  for (const r of doc.results ?? []) {
    if (r.source?.path) sources.push(r.source.path.replace(/^\/work\/repo\//, ''))
    for (const p of r.packages ?? []) {
      const eco = p.package.ecosystem.toLowerCase()
      const anchor = `${eco}:${p.package.name}@${p.package.version}`
      if (seen.has(anchor)) continue
      seen.add(anchor)
      const vulns = p.vulnerabilities ?? []
      const ids = (p.groups?.length ? p.groups.map((g) => g.ids[0]!) : vulns.map((v) => v.id)).filter(Boolean)
      findings.push({
        category: o.category,
        anchor,
        title: title(`${p.package.name}@${p.package.version}: ${ids.length} known vulnerabilit${ids.length === 1 ? 'y' : 'ies'}`),
        body: vulns
          .map((v) => `- **${v.id}**${v.aliases?.length ? ` (${v.aliases.join(', ')})` : ''}: ${v.summary ?? ''} — https://osv.dev/vulnerability/${v.id}`)
          .join('\n')
          .slice(0, BODY_MAX),
        severity: osvSeverity(p),
      })
    }
  }
  return { findings, notes: [`${o.tool}: scanned ${sources.join(', ') || 'no lockfile'}; ${findings.length} vulnerable package version(s)`] }
}
