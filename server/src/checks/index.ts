import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { DELIVERIES, type CheckSettings, type Config } from '../config/index.js'

/**
 * A check is a file on the volume (`checks/<kind>.md`): frontmatter for the machine, the body is
 * the prompt. Seeded on first boot, never overwritten — the volume copy is the live one.
 */

export const CHECK_KINDS = [
  'docs', 'cve', 'deps', 'dead-code', 'refactor', 'quality', 'patterns', 'architecture', 'security',
] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

const frontSchema = z.object({
  kind: z.enum(CHECK_KINDS),
  title: z.string(),
  revision: z.number().int().min(1),
  scopes: z.array(z.enum(['diff', 'full'])).min(1),
  agent: z.enum(['none', 'review']),
  detectors: z.array(z.enum(['osv', 'npm-outdated'])).default([]),
  categories: z.array(z.string()).min(1),
  sensitive: z.enum(['never', 'always']).default('never'),
  defaults: z.object({
    enabled: z.boolean(),
    delivery: z.enum(DELIVERIES),
    auto_submit: z.boolean(),
    armed: z.boolean(),
    cadence_days: z.number().int().min(1),
  }),
})

export type CheckDef = z.infer<typeof frontSchema> & { prompt: string; file: string }
export type ResolvedSettings = Required<CheckSettings>

export class Checks {
  private defs = new Map<CheckKind, CheckDef>()
  errors: string[] = []

  constructor(private readonly dir: string, seedDir: string) {
    mkdirSync(dir, { recursive: true })
    const seed = join(seedDir, 'checks')
    if (existsSync(seed)) {
      for (const f of readdirSync(seed)) {
        if (f.endsWith('.md') && !existsSync(join(dir, f))) copyFileSync(join(seed, f), join(dir, f))
      }
    }
    this.reload()
  }

  reload(): void {
    this.defs.clear()
    this.errors = []
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.md')) continue
      try {
        const parsed = matter(readFileSync(join(this.dir, f), 'utf8'))
        const front = frontSchema.parse(parsed.data)
        this.defs.set(front.kind, { ...front, prompt: parsed.content.trim(), file: f })
      } catch (err) {
        this.errors.push(`${f}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  get(kind: string): CheckDef | undefined {
    return this.defs.get(kind as CheckKind)
  }

  list(): CheckDef[] {
    return CHECK_KINDS.map((k) => this.defs.get(k)).filter((d): d is CheckDef => !!d)
  }
}

/** default (check file) → config.yaml → group → repo. Later wins, key by key. */
export function resolveSettings(
  def: CheckDef,
  config: Config,
  groupSettings: Record<string, unknown>,
  repoSettings: Record<string, unknown>,
): ResolvedSettings {
  const pick = (s: Record<string, unknown>) =>
    ((s.checks as Record<string, CheckSettings> | undefined)?.[def.kind] ?? {}) as CheckSettings
  // Every check takes every delivery mode: what lands (a report, a branch, a PR, a push) is the
  // maintainer's choice per check, not a property of the check. (A volume file from 0.2 may still
  // carry `fixable: false`; it is ignored.)
  const merged = {
    ...def.defaults,
    ...(config.checks[def.kind] ?? {}),
    ...pick(groupSettings),
    ...pick(repoSettings),
  }
  return merged as ResolvedSettings
}
