import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import YAML from 'yaml'
import { z } from 'zod'
import type { Env } from '../env.js'

/**
 * `config.yaml` on the volume is what is running. It is read at boot; the Settings page and the
 * admin tools change it through `updateConfig`, which applies the change to the live object *and*
 * writes it back into the file with comments kept (Touchstone's controls, 2026-10-27).
 */

export const DELIVERIES = ['report', 'branch', 'pr', 'push'] as const
export type Delivery = (typeof DELIVERIES)[number]

export const checkSettingsSchema = z
  .object({
    enabled: z.boolean(),
    delivery: z.enum(DELIVERIES),
    auto_submit: z.boolean(),
    armed: z.boolean(),
    cadence_days: z.number().int().min(1).max(365),
  })
  .partial()
export type CheckSettings = z.infer<typeof checkSettingsSchema>

export const inferenceSchema = z.object({
      driver: z.enum(['claude-code', 'openai']).default('claude-code'),
      url: z.string().default('http://beacon-backend:9300/mcp'),
      tool: z.string().default('claude-code__query_claude'),
      via: z.enum(['beacon', 'direct']).default('beacon'),
      model: z.string().default(''),
      workdir: z.string().default(''),
      timeout_s: z.number().int().min(30).max(14400).default(1800),
      max_tool_rounds: z.number().int().min(1).max(300).default(80),
})
export const identitySchema = z.object({
      name: z.string().default('Lamplighter'),
      email: z.string().default('lamplighter@localhost'),
})
export const scheduleSchema = z.object({
      enabled: z.boolean().default(true),
      rotation: z.boolean().default(false),
      tick_s: z.number().int().min(5).max(3600).default(30),
      poll_min: z.number().int().min(1).max(1440).default(15),
      debounce_min: z.number().int().min(0).max(120).default(2),
      slots: z.number().int().min(1).max(16).default(2),
      sessions_per_day: z.number().int().min(0).max(10000).default(40),
      deliveries_per_day: z.number().int().min(0).max(1000).default(10),
      open_items_per_repo: z.number().int().min(1).max(100).default(5),
})

export const configSchema = z.object({
  public_url: z.string().default('http://lamplighter-backend:8080'),
  inference: inferenceSchema.default({}),
  identity: identitySchema.default({}),
  schedule: scheduleSchema.default({}),
  checks: z.record(z.string(), checkSettingsSchema).default({}),
})
export type Config = z.infer<typeof configSchema>

const TEMPLATE = `# Lamplighter configuration. Read at boot; the Settings page writes changes back here.

# How the inference backend reaches Lamplighter's workspace endpoint (the agent's callback).
public_url: __PUBLIC_URL__

inference:
  driver: __DRIVER__         # claude-code (MCP query_claude) | openai (any /chat/completions with tools)
  url: __URL__
  tool: __TOOL__             # claude-code only
  via: __VIA__               # claude-code only: beacon (aggregator \`call\` envelope) | direct
  model: "__MODEL__"         # openai only
  workdir: ""                # claude-code only: agent cwd, empty = the backend's default
  timeout_s: 1800            # one session (round or proposal)
  max_tool_rounds: 80        # openai only: Lamplighter runs the tool loop

identity:                    # author of every commit Lamplighter makes
  name: Lamplighter
  email: lamplighter@localhost

schedule:
  enabled: true              # the tick: polling, queue, delivery status
  rotation: false            # full rounds by cadence across the fleet (spends budget)
  tick_s: 30
  poll_min: 15               # how often each remote is fetched (webhooks make it immediate)
  debounce_min: 2            # pushes closer than this coalesce into one diff round
  slots: 2                   # concurrent agent sessions
  sessions_per_day: 40       # agent sessions per day across the fleet; detector-only rounds are free
  deliveries_per_day: 10     # branches / PRs / pushes per day across the fleet
  open_items_per_repo: 5     # attention cap: no new proposal while a repo has this many open items

# Per-check overrides of the defaults in checks/<kind>.md. Group and repo settings override these.
checks: {}
`

export class ConfigStore {
  private doc: YAML.Document
  current: Config

  constructor(private readonly file: string, env: Env) {
    if (!existsSync(file)) {
      const s = env.seed
      writeFileSync(
        file,
        TEMPLATE.replace('__PUBLIC_URL__', s.publicUrl ?? 'http://lamplighter-backend:8080')
          .replace('__DRIVER__', s.inferenceDriver ?? 'claude-code')
          .replace('__URL__', s.inferenceUrl ?? 'http://beacon-backend:9300/mcp')
          .replace('__TOOL__', s.inferenceTool ?? 'claude-code__query_claude')
          .replace('__VIA__', s.inferenceVia ?? 'beacon')
          .replace('__MODEL__', s.inferenceModel ?? ''),
      )
    }
    this.doc = YAML.parseDocument(readFileSync(file, 'utf8'))
    this.current = configSchema.parse(this.doc.toJS() ?? {})
  }

  /** Set one scalar at the root of the file (e.g. `public_url`). */
  setRoot(key: 'public_url', value: string): Config {
    const parsed = configSchema.parse({ ...((this.doc.toJS() as object) ?? {}), [key]: value })
    this.doc.set(key, value)
    writeFileSync(this.file, this.doc.toString())
    this.current = parsed
    return parsed
  }

  /** Apply `patch` at `path` (e.g. ['inference']), validate the whole result, then persist. */
  update(path: string[], patch: Record<string, unknown> | null): Config {
    const candidate = structuredClone(this.doc.toJS() ?? {}) as Record<string, unknown>
    let node: Record<string, unknown> = candidate
    for (const key of path.slice(0, -1)) {
      node[key] = (node[key] as Record<string, unknown>) ?? {}
      node = node[key] as Record<string, unknown>
    }
    const last = path[path.length - 1]!
    if (patch === null) delete node[last]
    else node[last] = { ...((node[last] as Record<string, unknown>) ?? {}), ...patch }
    const parsed = configSchema.parse(candidate)

    if (patch === null) this.doc.deleteIn(path)
    else for (const [k, v] of Object.entries(patch)) this.doc.setIn([...path, k], v)
    writeFileSync(this.file, this.doc.toString())
    this.current = parsed
    return parsed
  }
}
