import type { App } from '../context.js'
import { newId, now } from '../db/index.js'
import { logEvent } from '../events.js'
import { forgeApi, forgeRow } from '../forges/index.js'
import { assertCanDeliver, commitIdentity, deliveryBlocker } from '../forges/auth.js'
import { git } from '../forges/gitcli.js'
import { asOwnBranch, TRAILER_CHECK, TRAILER_ROUND } from '../forges/refs.js'
import { addItem, openItemFor, recordOverride, resolveFor } from '../activity/index.js'
import { getRepo, type RepoRow } from '../repos/registry.js'
import { deleteOwnBranch, fastForwardLine, LineMovedError, pushOwnBranch } from '../repos/push.js'

export type ProposalState =
  | 'drafting' | 'validating' | 'ready' | 'held' | 'submitted' | 'landed' | 'rejected' | 'failed' | 'stale' | 'reverted'

export interface ProposalRow {
  id: string
  repo_key: string
  check_kind: string
  branch: string
  base_sha: string
  head_sha: string | null
  state: ProposalState
  delivery: 'branch' | 'pr' | 'push' | 'report'
  sensitive: number
  finding_ids: string
  summary: string | null
  patch: string | null
  validation: string | null
  submitted_ref: string | null
  error: string | null
  created_at: string
  updated_at: string
}

export function getProposal(db: App['db'], id: string): ProposalRow | undefined {
  return db.prepare('SELECT * FROM proposals WHERE id = ?').get(id) as ProposalRow | undefined
}

function mustGet(app: App, id: string): ProposalRow {
  const p = getProposal(app.db, id)
  if (!p) throw new Error(`no proposal ${id}`)
  return p
}

function setState(app: App, id: string, state: ProposalState, extra: { error?: string; submitted_ref?: string } = {}) {
  app.db
    .prepare('UPDATE proposals SET state = ?, error = COALESCE(?, error), submitted_ref = COALESCE(?, submitted_ref), updated_at = ? WHERE id = ?')
    .run(state, extra.error ?? null, extra.submitted_ref ?? null, now(), id)
}

/**
 * Hand the proposal's findings back. `block` remembers that this input was tried, so the same
 * findings are not proposed again until what they are about changes.
 */
function releaseFindings(app: App, p: ProposalRow, to: 'open' | 'fixed', block: boolean) {
  const t = now()
  for (const id of JSON.parse(p.finding_ids) as string[]) {
    if (to === 'fixed') app.db.prepare("UPDATE findings SET state = 'fixed', updated_at = ? WHERE id = ? AND proposal_id = ?").run(t, id, p.id)
    else
      app.db
        .prepare(`UPDATE findings SET state = 'open', proposal_id = NULL, blocked_input = ${block ? 'input_hash' : 'blocked_input'}, updated_at = ? WHERE id = ? AND proposal_id = ?`)
        .run(t, id, p.id)
  }
}

export function failProposal(app: App, id: string, reason: string, opts: { block?: boolean } = {}) {
  const p = mustGet(app, id)
  setState(app, id, 'failed', { error: reason })
  releaseFindings(app, p, 'open', opts.block ?? true)
  logEvent(app.db, { level: 'warn', code: 'PROPOSAL_FAILED', repo: p.repo_key, message: `${p.check_kind} proposal failed: ${reason.slice(0, 300)}`, detail: { proposal: id } })
}

export function deliveriesToday(app: App): number {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  return (app.db.prepare("SELECT COUNT(*) AS n FROM events WHERE code = 'DELIVERED' AND at > ?").get(since) as { n: number }).n
}

function title(p: ProposalRow): string {
  if (p.sensitive) return `${p.check_kind}: maintenance`
  return (p.summary ?? '').split('\n')[0]!.replace(/^#+\s*/, '').slice(0, 100) || `${p.check_kind} maintenance`
}

async function visibility(app: App, repo: RepoRow): Promise<RepoRow['visibility']> {
  const forge = forgeRow(app.db, repo.forge_id)
  if (forge.kind === 'git') return repo.visibility
  try {
    const info = await forgeApi(forge).repoInfo(repo.owner, repo.name)
    if (info.visibility !== repo.visibility) app.db.prepare('UPDATE repos SET visibility = ? WHERE key = ?').run(info.visibility, repo.key)
    return info.visibility
  } catch {
    return repo.visibility
  }
}

/** A validated proposal: hold it, ask for approval, or deliver it, per the switches. */
export async function afterReady(app: App, id: string): Promise<void> {
  const p = mustGet(app, id)
  const repo = getRepo(app.db, p.repo_key)
  const def = app.checks.get(p.check_kind)
  if (p.sensitive && (await visibility(app, repo)) === 'public') {
    setState(app, id, 'held')
    addItem(app.db, {
      kind: 'held', repo: repo.key, ref: id, sensitive: true,
      title: `Sensitive ${p.check_kind} fix held for ${repo.key}`,
      body: 'The repository is public, so this fix was not pushed. Review the patch here; deliver it yourself (its commit message is neutral) or reject it.',
    })
    return
  }
  const { resolveSettings } = await import('../checks/index.js')
  const { getGroup, parseSettings } = await import('../repos/registry.js')
  const s = def ? resolveSettings(def, app.config.current, parseSettings(getGroup(app.db, repo.group_id).settings_json), parseSettings(repo.settings_json)) : undefined
  let waiting = ''
  if (s?.auto_submit) {
    const blocker = deliveryBlocker(forgeRow(app.db, repo.forge_id), `${repo.owner}/${repo.name}`)
    if (blocker) waiting = ` (auto-submit waiting: ${blocker})`
    else if (deliveriesToday(app) >= app.config.current.schedule.deliveries_per_day) waiting = ' (auto-submit waiting on the daily delivery cap)'
    else {
      try {
        await deliver(app, id, 'auto')
        return
      } catch (err) {
        // The fix is validated; a failed push says nothing about it. It stays ready for a person.
        if (mustGet(app, id).state !== 'ready') throw err
        waiting = ` (auto-submit failed: ${(err as Error).message.slice(0, 300)})`
        logEvent(app.db, { level: 'warn', code: 'DELIVERY_FAILED', repo: repo.key, message: `${p.check_kind} auto-delivery: ${(err as Error).message}`, detail: { proposal: id } })
      }
    }
  }
  addItem(app.db, {
    kind: 'proposal-ready', repo: repo.key, ref: id, sensitive: !!p.sensitive,
    title: title(p),
    body: `${p.check_kind} · ${JSON.parse(p.finding_ids).length} finding(s) · delivery: ${p.delivery}${waiting}`,
  })
}

export async function deliver(app: App, id: string, by: string): Promise<ProposalRow> {
  const p = mustGet(app, id)
  if (p.state !== 'ready' && p.state !== 'held') throw new Error(`proposal is ${p.state}, not ready`)
  if (!p.head_sha) throw new Error('proposal has no commit')
  const repo = getRepo(app.db, p.repo_key)
  const forge = forgeRow(app.db, repo.forge_id)
  assertCanDeliver(forge, `${repo.owner}/${repo.name}`)
  const branch = asOwnBranch(p.branch)
  try {
    if (p.delivery === 'push') {
      await fastForwardLine(app.mirrors, repo, p.head_sha)
      setState(app, id, 'landed')
      releaseFindings(app, p, 'fixed', false)
      resolveFor(app.db, id, 'delivered')
      addItem(app.db, { kind: 'pushed', repo: repo.key, ref: id, sensitive: !!p.sensitive, title: `Pushed to ${repo.line}: ${title(p)}`, body: `${p.head_sha.slice(0, 10)} fast-forwarded ${repo.line}. Revert is one click.` })
    } else if (p.delivery === 'pr' && forge.kind !== 'git') {
      await pushOwnBranch(app.mirrors, repo, branch, p.head_sha)
      const api = forgeApi(forge)
      let pr
      try {
        pr = await api.openPr!(repo.owner, repo.name, { head: branch, base: repo.line, title: title(p), body: prBody(p) })
      } catch (err) {
        await deleteOwnBranch(app.mirrors, repo, branch).catch(() => undefined)
        throw err
      }
      setState(app, id, 'submitted', { submitted_ref: JSON.stringify(pr) })
      resolveFor(app.db, id, 'delivered')
      addItem(app.db, { kind: 'pr-open', repo: repo.key, ref: id, url: pr.url, sensitive: !!p.sensitive, title: `PR #${pr.number}: ${title(p)}`, body: `Review it on the forge. Lamplighter follows it and cleans up its branch when it is merged or closed.` })
    } else {
      await pushOwnBranch(app.mirrors, repo, branch, p.head_sha)
      setState(app, id, 'submitted', { submitted_ref: JSON.stringify({ branch }) })
      resolveFor(app.db, id, 'delivered')
      addItem(app.db, { kind: 'branch-open', repo: repo.key, ref: id, sensitive: !!p.sensitive, title: `Branch ${branch}: ${title(p)}`, body: `Pushed to ${repo.key}. Merge fast-forwards ${repo.line}; Close deletes the branch.` })
    }
  } catch (err) {
    if (err instanceof LineMovedError) {
      setState(app, id, 'stale', { error: err.message })
      releaseFindings(app, p, 'open', false)
      resolveFor(app.db, id, 'stale', err.message)
      logEvent(app.db, { level: 'warn', code: 'PROPOSAL_STALE', repo: repo.key, message: err.message, detail: { proposal: id } })
    }
    throw err
  }
  logEvent(app.db, { code: 'DELIVERED', repo: repo.key, message: `${p.check_kind} delivered as ${p.delivery} by ${by}`, detail: { proposal: id } })
  return mustGet(app, id)
}

function prBody(p: ProposalRow): string {
  if (p.sensitive) return 'Maintenance change prepared by Lamplighter.'
  const body = (p.summary ?? '').split('\n').slice(1).join('\n').trim()
  return `${body}\n\n---\n_Prepared by Lamplighter (${p.check_kind}), validated by an independent review session. Proposal \`${p.id}\`._`
}

/** Bare-git review: fast-forward the line to the delivered branch, then remove the branch. */
export async function mergeBranch(app: App, id: string, by: string): Promise<ProposalRow> {
  const p = mustGet(app, id)
  if (p.state !== 'submitted' || !p.head_sha) throw new Error(`proposal is ${p.state}`)
  const repo = getRepo(app.db, p.repo_key)
  try {
    await fastForwardLine(app.mirrors, repo, p.head_sha)
  } catch (err) {
    if (err instanceof LineMovedError) {
      setState(app, id, 'stale', { error: err.message })
      releaseFindings(app, p, 'open', false)
      resolveFor(app.db, id, 'stale', err.message)
    }
    throw err
  }
  await deleteOwnBranch(app.mirrors, repo, asOwnBranch(p.branch)).catch(() => undefined)
  setState(app, id, 'landed')
  releaseFindings(app, p, 'fixed', false)
  resolveFor(app.db, id, 'merged')
  recordOverride(app.db, { activity: openItemFor(app.db, id)?.id, proposed: { proposal: id }, decided: 'merged' })
  logEvent(app.db, { code: 'MERGED', repo: repo.key, message: `${p.check_kind} branch merged into ${repo.line} by ${by}`, detail: { proposal: id } })
  return mustGet(app, id)
}

/** A person says no — to a ready proposal, a held one, or a delivered branch. */
export async function rejectProposal(app: App, id: string, reason: string, by: string): Promise<ProposalRow> {
  const p = mustGet(app, id)
  if (!['ready', 'held', 'submitted'].includes(p.state)) throw new Error(`proposal is ${p.state}`)
  const repo = getRepo(app.db, p.repo_key)
  if (p.state === 'submitted') await deleteOwnBranch(app.mirrors, repo, asOwnBranch(p.branch)).catch(() => undefined)
  const item = openItemFor(app.db, id)
  recordOverride(app.db, { activity: item?.id, proposed: { proposal: id, summary: p.summary }, decided: 'rejected', reason })
  setState(app, id, 'rejected', { error: reason || undefined })
  releaseFindings(app, p, 'open', true)
  resolveFor(app.db, id, 'rejected', reason)
  logEvent(app.db, { code: 'REJECTED', repo: repo.key, message: `${p.check_kind} proposal rejected by ${by}: ${reason}`, detail: { proposal: id } })
  return mustGet(app, id)
}

/** Undo a push: a revert commit on top of the line, fast-forwarded like any push. */
export async function revertPush(app: App, id: string, by: string): Promise<ProposalRow> {
  const p = mustGet(app, id)
  if (p.state !== 'landed' || p.delivery !== 'push' || !p.head_sha) throw new Error('only a pushed proposal can be reverted')
  const repo = getRepo(app.db, p.repo_key)
  assertCanDeliver(forgeRow(app.db, repo.forge_id), `${repo.owner}/${repo.name}`)
  const head = await app.mirrors.fetch(repo)
  const wtId = newId('rv')
  const wt = await app.mirrors.addWorktree(repo, wtId, head)
  try {
    const ident = commitIdentity(app, repo.forge_id)
    await git(['revert', '--no-commit', `${p.base_sha}..${p.head_sha}`], { cwd: wt, config: { 'user.name': ident.name, 'user.email': ident.email } })
    await git(['commit', '-q', '-F', '-'], {
      cwd: wt,
      config: { 'user.name': ident.name, 'user.email': ident.email, 'commit.gpgsign': 'false' },
      input: `Revert Lamplighter ${p.check_kind} change ${p.head_sha.slice(0, 10)}\n\nRequested by ${by}.\n\n${TRAILER_ROUND}: ${wtId}\n${TRAILER_CHECK}: ${p.check_kind}\n`,
    })
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: wt })).trim()
    await fastForwardLine(app.mirrors, repo, sha)
  } finally {
    await app.mirrors.removeWorktree(repo, wt)
  }
  setState(app, id, 'reverted')
  const t = now()
  for (const fid of JSON.parse(p.finding_ids) as string[]) {
    app.db.prepare("UPDATE findings SET state = 'open', proposal_id = NULL, blocked_input = input_hash, updated_at = ? WHERE id = ?").run(t, fid)
  }
  recordOverride(app.db, { activity: openItemFor(app.db, id)?.id, proposed: { proposal: id }, decided: 'reverted' })
  resolveFor(app.db, id, 'reverted')
  logEvent(app.db, { code: 'REVERTED', repo: repo.key, message: `${p.check_kind} push reverted by ${by}`, detail: { proposal: id } })
  return mustGet(app, id)
}

/** Follow open PRs: merged → landed and the branch goes; closed → rejected and the branch goes. */
export async function pollPullRequests(app: App): Promise<void> {
  const open = app.db.prepare("SELECT * FROM proposals WHERE state = 'submitted' AND delivery = 'pr'").all() as ProposalRow[]
  for (const p of open) {
    const ref = JSON.parse(p.submitted_ref ?? '{}') as { number?: number }
    if (!ref.number) continue
    const repo = getRepo(app.db, p.repo_key)
    const api = forgeApi(forgeRow(app.db, repo.forge_id))
    try {
      const state = await api.prState!(repo.owner, repo.name, ref.number)
      if (state === 'open') continue
      await deleteOwnBranch(app.mirrors, repo, asOwnBranch(p.branch)).catch(() => undefined)
      if (state === 'merged') {
        setState(app, p.id, 'landed')
        releaseFindings(app, p, 'fixed', false)
        resolveFor(app.db, p.id, 'merged')
      } else {
        setState(app, p.id, 'rejected', { error: 'PR closed without merge' })
        releaseFindings(app, p, 'open', true)
        recordOverride(app.db, { proposed: { proposal: p.id }, decided: 'pr-closed' })
        resolveFor(app.db, p.id, 'closed')
      }
      logEvent(app.db, { code: state === 'merged' ? 'MERGED' : 'PR_CLOSED', repo: repo.key, message: `PR #${ref.number} ${state}; branch ${p.branch} deleted`, detail: { proposal: p.id } })
    } catch (err) {
      logEvent(app.db, { level: 'warn', code: 'PR_POLL_FAILED', repo: repo.key, message: (err as Error).message })
    }
  }
}
