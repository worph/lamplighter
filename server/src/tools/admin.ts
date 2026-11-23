import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { CHECK_KINDS } from '../checks/index.js'
import { checkSettingsSchema } from '../config/index.js'
import type { App } from '../context.js'
import { listEvents, logEvent } from '../events.js'
import { dismiss, getFinding, lastDismissal, listFindings, reopen } from '../findings/index.js'
import { listItems } from '../activity/index.js'
import { addRepo, getRepo, listRepos, parseSettings, getGroup } from '../repos/registry.js'
import { enqueueRound } from '../scheduler/index.js'
import { maybePropose } from '../sessions/engine.js'
import { writeAccess } from '../forges/auth.js'
import { deliver, getProposal, mergeBranch, rejectProposal, revertPush } from '../delivery/index.js'

/**
 * One registry behind the admin MCP and the chat (Newsdesk/Aube's shape). Tools marked `chat`
 * exist only in the chat and only run after a typed confirmation: the MCP can read, configure,
 * request, dismiss and reject what has not left Lamplighter, but it cannot approve, merge, push
 * or revert anything, nor touch a forge (invariant 9).
 */

export interface AdminTool<S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>> {
  name: string
  title: string
  description: string
  schema: S
  scope: 'both' | 'chat'
  readOnly?: boolean
  /** The word the operator must type to let a decisive tool run. */
  confirm?: (input: z.infer<S>) => string
  run(app: App, input: z.infer<S>, caller: string): Promise<unknown>
}

function tool<S extends z.ZodObject<z.ZodRawShape>>(t: AdminTool<S>): AdminTool {
  return t as unknown as AdminTool
}

const kind = z.enum(CHECK_KINDS)

export const ADMIN_TOOLS: AdminTool[] = [
  tool({
    name: 'list_repos', title: 'List repositories', scope: 'both', readOnly: true,
    description: 'Every monitored repository with its forge, line, visibility, and open finding counts per check.',
    schema: z.object({}),
    async run(app) {
      const counts = app.db
        .prepare("SELECT repo_key, check_kind, COUNT(*) AS n FROM findings WHERE state IN ('open','proposed') GROUP BY repo_key, check_kind")
        .all() as { repo_key: string; check_kind: string; n: number }[]
      return listRepos(app.db).map((r) => ({
        key: r.key, line: r.line, visibility: r.visibility, group: r.group_id, head: r.last_head?.slice(0, 10) ?? null, fetch_error: r.fetch_error,
        write: writeAccess(app, r),
        open: Object.fromEntries(counts.filter((c) => c.repo_key === r.key).map((c) => [c.check_kind, c.n])),
      }))
    },
  }),
  tool({
    name: 'get_repo', title: 'Repository detail', scope: 'both', readOnly: true,
    description: 'One repository: settings, policy, the last round of each check and its proposals.',
    schema: z.object({ repo: z.string() }),
    async run(app, { repo }) {
      const r = getRepo(app.db, repo)
      const rounds = app.db
        .prepare("SELECT id, check_kind, kind, scope, status, summary, started_at FROM rounds WHERE repo_key = ? ORDER BY started_at DESC LIMIT 30")
        .all(repo)
      const proposals = app.db.prepare('SELECT id, check_kind, state, delivery, branch, error, updated_at FROM proposals WHERE repo_key = ? ORDER BY created_at DESC LIMIT 20').all(repo)
      return { ...r, settings: parseSettings(r.settings_json), settings_json: undefined, rounds, proposals }
    },
  }),
  tool({
    name: 'list_findings', title: 'List findings', scope: 'both', readOnly: true,
    description: 'Findings, filtered by repo, check and state (open, proposed, dismissed, fixed, gone).',
    schema: z.object({ repo: z.string().optional(), check: kind.optional(), state: z.enum(['open', 'proposed', 'dismissed', 'fixed', 'gone']).optional(), limit: z.number().int().min(1).max(500).optional() }),
    async run(app, f) {
      return listFindings(app.db, { ...f, limit: f.limit ?? 100 }).map((x) => ({
        id: x.id, repo: x.repo_key, check: x.check_kind, state: x.state, severity: x.severity, category: x.category, anchor: x.anchor, title: x.title, sensitive: !!x.sensitive,
      }))
    },
  }),
  tool({
    name: 'get_finding', title: 'Finding detail', scope: 'both', readOnly: true,
    description: 'One finding with its full body and, if dismissed, the reason.',
    schema: z.object({ id: z.string() }),
    async run(app, { id }) {
      const f = getFinding(app.db, id)
      if (!f) throw new Error(`no finding ${id}`)
      return { ...f, dismissal: lastDismissal(app.db, id) ?? null }
    },
  }),
  tool({
    name: 'get_round_report', title: 'Round report', scope: 'both', readOnly: true,
    description: 'The markdown report a round (review, fix or validation session) wrote.',
    schema: z.object({ round: z.string() }),
    async run(app, { round }) {
      const r = app.db.prepare('SELECT * FROM rounds WHERE id = ?').get(round)
      if (!r) throw new Error(`no round ${round}`)
      return r
    },
  }),
  tool({
    name: 'list_activity', title: 'Activity', scope: 'both', readOnly: true,
    description: 'Items awaiting a person (state open) or resolved, and the recent event log.',
    schema: z.object({ state: z.enum(['open', 'resolved']).optional(), events: z.number().int().min(0).max(200).optional() }),
    async run(app, { state, events }) {
      return { items: listItems(app.db, { state: state ?? 'open', limit: 100 }), events: listEvents(app.db, { limit: events ?? 20 }) }
    },
  }),
  tool({
    name: 'get_proposal', title: 'Proposal detail', scope: 'both', readOnly: true,
    description: 'One proposal: state, delivery, description, validation verdict and its patch.',
    schema: z.object({ id: z.string() }),
    async run(app, { id }) {
      const p = getProposal(app.db, id)
      if (!p) throw new Error(`no proposal ${id}`)
      return { ...p, validation: p.validation ? JSON.parse(p.validation) : null }
    },
  }),
  tool({
    name: 'get_schedule', title: 'Schedule', scope: 'both', readOnly: true,
    description: 'What is running, what is queued and why it waits, and the day’s budget.',
    schema: z.object({}),
    async run(app) {
      return app.schedule()
    },
  }),
  tool({
    name: 'list_checks', title: 'Checks', scope: 'both', readOnly: true,
    description: 'The checks on the volume with their revision, scopes and effective global settings.',
    schema: z.object({}),
    async run(app) {
      return app.checks.list().map((c) => ({
        kind: c.kind, title: c.title, revision: c.revision, scopes: c.scopes, agent: c.agent, sensitive: c.sensitive,
        settings: { ...c.defaults, ...(app.config.current.checks[c.kind] ?? {}) },
      }))
    },
  }),
  tool({
    name: 'request_round', title: 'Request a round', scope: 'both',
    description: 'Queue one round of one check on one repository, ahead of the background work. Returns at once; the round runs when a slot is free.',
    schema: z.object({ repo: z.string(), check: kind, scope: z.enum(['full', 'diff']).optional() }),
    async run(app, { repo, check, scope }) {
      const r = getRepo(app.db, repo)
      if (!app.checks.get(check)) throw new Error(`no check ${check}`)
      const q = enqueueRound(app, { repo: r.key, check, scope: scope ?? 'full', foreground: true, tier: 0, trigger: 'request' })
      return { queued: q.id, coalesced: q.coalesced }
    },
  }),
  tool({
    name: 'request_fix', title: 'Request a fix', scope: 'both',
    description: 'Ask Lamplighter to prepare a proposal for the open findings of one check on one repo, even if the check is not armed. The proposal is validated and then waits for approval (or follows auto-submit).',
    schema: z.object({ repo: z.string(), check: kind }),
    async run(app, { repo, check }) {
      const def = app.checks.get(check)
      if (!def) throw new Error(`no check ${check}`)
      return { result: maybePropose(app, getRepo(app.db, repo), def, true) }
    },
  }),
  tool({
    name: 'dismiss_finding', title: 'Dismiss a finding', scope: 'both',
    description: 'Mark a finding as won’t-fix, with a reason. It stays dismissed until the code it is about changes.',
    schema: z.object({ id: z.string(), reason: z.string().min(3) }),
    async run(app, { id, reason }, caller) {
      const f = dismiss(app.db, id, reason, caller)
      logEvent(app.db, { code: 'DISMISSED', repo: f.repo_key, message: `${f.title} — dismissed by ${caller}: ${reason}` })
      return { id: f.id, state: f.state }
    },
  }),
  tool({
    name: 'reopen_finding', title: 'Reopen a finding', scope: 'both',
    description: 'Put a dismissed (or gone) finding back to open.',
    schema: z.object({ id: z.string() }),
    async run(app, { id }) {
      const f = reopen(app.db, id)
      return { id: f.id, state: f.state }
    },
  }),
  tool({
    name: 'set_policy', title: 'Set policy', scope: 'both',
    description: 'Replace the prose policy of a group or a repository. Every check’s prompt carries it.',
    schema: z.object({ target: z.enum(['group', 'repo']), id: z.string(), policy: z.string().max(20000) }),
    async run(app, { target, id, policy }, caller) {
      if (target === 'group') {
        getGroup(app.db, id)
        app.db.prepare('UPDATE groups SET policy = ? WHERE id = ?').run(policy, id)
      } else {
        getRepo(app.db, id)
        app.db.prepare('UPDATE repos SET policy = ? WHERE key = ?').run(policy, id)
      }
      logEvent(app.db, { code: 'POLICY_SET', repo: target === 'repo' ? id : null, message: `${target} ${id} policy changed by ${caller}` })
      return { ok: true }
    },
  }),
  tool({
    name: 'set_check_settings', title: 'Set check settings', scope: 'both',
    description: 'Change a check’s switches (enabled, delivery report|branch|pr|push, auto_submit, armed, cadence_days) globally, for a group, or for one repo.',
    schema: z.object({ level: z.enum(['global', 'group', 'repo']), id: z.string().optional(), check: kind, settings: checkSettingsSchema }),
    async run(app, { level, id, check, settings }, caller) {
      if (level === 'global') {
        app.config.update(['checks', check], settings)
      } else {
        if (!id) throw new Error('id is required for group or repo')
        const table = level === 'group' ? 'groups' : 'repos'
        const col = level === 'group' ? 'id' : 'key'
        const row = app.db.prepare(`SELECT settings_json FROM ${table} WHERE ${col} = ?`).get(id) as { settings_json: string } | undefined
        if (!row) throw new Error(`no ${level} ${id}`)
        const s = parseSettings(row.settings_json) as { checks?: Record<string, unknown> }
        s.checks = { ...(s.checks ?? {}), [check]: { ...((s.checks?.[check] as object) ?? {}), ...settings } }
        app.db.prepare(`UPDATE ${table} SET settings_json = ? WHERE ${col} = ?`).run(JSON.stringify(s), id)
      }
      logEvent(app.db, { code: 'SETTINGS_SET', repo: level === 'repo' ? id : null, message: `${check} settings (${level}${id ? ` ${id}` : ''}) changed by ${caller}: ${JSON.stringify(settings)}` })
      return { ok: true }
    },
  }),
  tool({
    name: 'add_repo', title: 'Add a repository', scope: 'both',
    description: 'Start monitoring a repository on a configured forge. Line and visibility come from the forge when it can say.',
    schema: z.object({
      forge_id: z.string(), owner: z.string().optional(), name: z.string(), remote_url: z.string().optional(), line: z.string().optional(),
      group_id: z.string().optional(), visibility: z.enum(['public', 'private']).optional(),
    }),
    async run(app, input, caller) {
      const r = await addRepo(app.db, input)
      logEvent(app.db, { code: 'REPO_ADDED', repo: r.key, message: `added by ${caller}` })
      void app.pollNow(r.key)
      return { key: r.key, line: r.line, visibility: r.visibility }
    },
  }),
  tool({
    name: 'approve_proposal', title: 'Approve a proposal', scope: 'chat',
    description: 'Deliver a validated proposal as configured (branch, PR or push). Decisive: needs typed confirmation.',
    schema: z.object({ id: z.string() }),
    confirm: ({ id }) => id,
    async run(app, { id }, caller) {
      const p = await deliver(app, id, caller)
      return { id: p.id, state: p.state, delivery: p.delivery }
    },
  }),
  tool({
    name: 'reject_proposal', title: 'Reject a proposal', scope: 'both',
    description:
      'Refuse a proposal with a reason. Its findings go back to open and are not proposed again until the code they are about changes. ' +
      'Over MCP only a proposal that has not left Lamplighter (ready or held); a delivered one (an open PR or branch) is rejected in Activity, since that deletes its branch on the forge. ' +
      'In the chat it needs typed confirmation.',
    schema: z.object({ id: z.string(), reason: z.string().min(3) }),
    confirm: ({ id }) => id,
    async run(app, { id, reason }, caller) {
      // The MCP never acts on a forge (invariant 9): rejecting a delivered proposal deletes its branch there.
      const state = getProposal(app.db, id)?.state
      if (caller === 'mcp' && state === 'submitted') {
        throw new Error(`proposal ${id} is delivered (an open PR or branch): reject it in Lamplighter's Activity page, where its branch on the forge is deleted too`)
      }
      const p = await rejectProposal(app, id, reason, caller)
      return { id: p.id, state: p.state }
    },
  }),
  tool({
    name: 'merge_branch', title: 'Merge a delivered branch', scope: 'chat',
    description: 'Fast-forward the line to a delivered branch (bare git review). Decisive: needs typed confirmation.',
    schema: z.object({ id: z.string() }),
    confirm: ({ id }) => id,
    async run(app, { id }, caller) {
      const p = await mergeBranch(app, id, caller)
      return { id: p.id, state: p.state }
    },
  }),
  tool({
    name: 'revert_push', title: 'Revert a push', scope: 'chat',
    description: 'Undo a pushed proposal with a revert commit on the line. Decisive: needs typed confirmation.',
    schema: z.object({ id: z.string() }),
    confirm: ({ id }) => id,
    async run(app, { id }, caller) {
      const p = await revertPush(app, id, caller)
      return { id: p.id, state: p.state }
    },
  }),
]

export function adminTool(name: string): AdminTool | undefined {
  return ADMIN_TOOLS.find((t) => t.name === name)
}

export function jsonSchema(t: AdminTool): Record<string, unknown> {
  const s = zodToJsonSchema(t.schema, { $refStrategy: 'none' }) as Record<string, unknown>
  delete s.$schema
  return s
}

export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
