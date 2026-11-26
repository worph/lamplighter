import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import matter from 'gray-matter'
import { z } from 'zod'
import { ADMISSIONS, DELIVERIES, LEANS, type CheckSettings, type Config } from '../config/index.js'

/**
 * A check is a file on the volume (`checks/<kind>.md`): frontmatter for the machine, the body is
 * the prompt. Seeded on first boot; the volume copy is the live one. A file an operator edited is
 * never overwritten; one still identical to an older release's seed is upgraded at boot.
 */

export const CHECK_KINDS = [
  'docs', 'cve', 'deps', 'dead-code', 'refactor', 'quality', 'patterns', 'architecture', 'security',
] as const
export type CheckKind = (typeof CHECK_KINDS)[number]

export const BUILTIN_DETECTORS = ['osv', 'npm-outdated'] as const
export type BuiltinDetector = (typeof BUILTIN_DETECTORS)[number]

/**
 * A scanner in its official image, run in the sandbox against the session's clone (read-only,
 * before any install). `run` is the argv after the image's entrypoint; the repository is at
 * /work/repo. Without the sandbox, `fallback` (a built-in) runs instead, or nothing.
 */
export const imageDetectorSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  run: z.array(z.string()),
  format: z.enum(['sarif', 'osv-json']),
  /** The finding category; default: the check's first. */
  category: z.string().optional(),
  /** Exit codes that mean "ran and found something", besides 0 (osv-scanner and gitleaks use 1). */
  ok_exit: z.array(z.number().int()).default([1]),
  fallback: z.enum(BUILTIN_DETECTORS).optional(),
})
export type ImageDetector = z.infer<typeof imageDetectorSchema>
export type DetectorDef = BuiltinDetector | ImageDetector

/** A static binary copied out of an official image onto the fixing session's PATH (§10.1). */
export const fixToolSchema = z.object({ image: z.string().min(1), path: z.string().min(1) })

const frontSchema = z.object({
  kind: z.enum(CHECK_KINDS),
  title: z.string(),
  revision: z.number().int().min(1),
  scopes: z.array(z.enum(['diff', 'full'])).min(1),
  agent: z.enum(['none', 'review']),
  detectors: z.array(z.union([z.enum(BUILTIN_DETECTORS), imageDetectorSchema])).default([]),
  fix_tools: z.array(fixToolSchema).default([]),
  categories: z.array(z.string()).min(1),
  sensitive: z.enum(['never', 'always']).default('never'),
  defaults: z.object({
    enabled: z.boolean(),
    delivery: z.enum(DELIVERIES),
    auto_submit: z.boolean(),
    armed: z.boolean(),
    cadence_days: z.number().int().min(1),
    admission: z.enum(ADMISSIONS).default('arbiter'),
    lean: z.enum(LEANS).default('admit'),
  }),
  /** The rule tier (§6.4): findings matching this are admitted without the arbiter, whatever the mode. */
  always_when: z.object({ severity: z.array(z.enum(['critical', 'major', 'minor'])).min(1) }).optional(),
})

export type CheckDef = z.infer<typeof frontSchema> & { prompt: string; file: string }
export type ResolvedSettings = Required<CheckSettings>

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}

/**
 * `seed/checks/history.json`: every version of each seed file any release shipped, by sha256.
 * A release that changes a seed adds the new hash (a test fails until it does).
 */
function seedHistory(seed: string): Record<string, string[]> {
  try {
    return JSON.parse(readFileSync(join(seed, 'history.json'), 'utf8')) as Record<string, string[]>
  } catch {
    return {}
  }
}

export class Checks {
  private defs = new Map<CheckKind, CheckDef>()
  errors: string[] = []

  /** Check files replaced at boot by a newer seed, because they were an untouched older seed. */
  upgraded: string[] = []

  constructor(private readonly dir: string, seedDir: string) {
    mkdirSync(dir, { recursive: true })
    const seed = join(seedDir, 'checks')
    if (existsSync(seed)) {
      const history = seedHistory(seed)
      for (const f of readdirSync(seed)) {
        if (!f.endsWith('.md')) continue
        const dest = join(dir, f)
        if (!existsSync(dest)) {
          copyFileSync(join(seed, f), dest)
          continue
        }
        // A file still byte-identical to a seed some release shipped was never edited: the newer
        // seed may replace it. An edited one is the operator's, and stays.
        const current = sha256(readFileSync(dest))
        if (current !== sha256(readFileSync(join(seed, f))) && history[f]?.includes(current)) {
          copyFileSync(join(seed, f), dest)
          this.upgraded.push(f)
        }
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
