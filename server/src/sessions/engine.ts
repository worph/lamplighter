import type { CheckDef } from '../checks/index.js'
import type { App } from '../context.js'
import { newId, now } from '../db/index.js'
import { logEvent } from '../events.js'
import { lastDismissal, reconcile, type FindingRow } from '../findings/index.js'
import { forgeRow } from '../forges/index.js'
import { commitIdentity, writeAccess } from '../forges/auth.js'
import { git } from '../forges/gitcli.js'
import { ownBranch, TRAILER_CHECK, TRAILER_ROUND } from '../forges/refs.js'
import { driverFor } from '../inference/index.js'
import { InferenceError } from '../inference/types.js'
import { addItem, openAlert, openCount } from '../activity/index.js'
import { getGroup, getRepo, settingsFor, type RepoRow } from '../repos/registry.js'
import { authorPrompt, confirmPrompt, roundPrompt } from './prompt.js'
import type { Session } from './session.js'
import { execTool, toolSpecs } from '../tools/workspace.js'
import { detect, hasImageDetectors } from '../sandbox/detect.js'
import { isSandbox, openWorkspace, SandboxError, sandboxRuntime, type SessionWorkspace } from '../sandbox/index.js'
import { mechanical, renderMechanical, renderScan, scanCheck } from '../sandbox/validate.js'
import { installFixTools } from '../sandbox/workspace.js'
import { afterReady, failProposal, getProposal, type ProposalRow } from '../delivery/index.js'

export interface QueueRow {
  id: string
  job: 'round' | 'author'
  repo_key: string
  check_kind: string
  scope: 'diff' | 'full'
  base_sha: string | null
  head_sha: string | null
  foreground: number
  tier: number
  trigger: string
  state: string
  created_at: string
  started_at: string | null
}

function checkOf(app: App, kind: string): CheckDef {
  const def = app.checks.get(kind)
  if (!def) throw new Error(`no check "${kind}" on the volume`)
  return def
}

function insertRound(app: App, r: { id: string; repo: string; def: CheckDef; kind: 'round' | 'author' | 'confirm'; scope: 'diff' | 'full'; base?: string | null; head: string; proposal?: string; trigger: string }) {
  app.db
    .prepare(
      `INSERT INTO rounds (id, repo_key, check_kind, check_revision, kind, scope, base_sha, head_sha, proposal_id, trigger, status, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(r.id, r.repo, r.def.kind, r.def.revision, r.kind, r.scope, r.base ?? null, r.head, r.proposal ?? null, r.trigger, now())
}

function endRound(app: App, id: string, f: { status: 'done' | 'blocked' | 'failed'; summary?: string; report?: string; error?: string; usage?: unknown }) {
  app.db
    .prepare('UPDATE rounds SET status = ?, summary = ?, report = ?, error = ?, usage_json = ?, ended_at = ? WHERE id = ?')
    .run(f.status, f.summary ?? null, f.report ?? null, f.error ?? null, f.usage ? JSON.stringify(f.usage) : null, now(), id)
}

/** Run one session through whichever driver is configured, and account for it. */
async function drive(app: App, s: Session, prompt: string, roundId: string) {
  const driver = driverFor(app.config.current, app.db)
  const cfg = app.config.current
  const result = await driver.runSession({
    sessionId: s.agentSessionId,
    prompt,
    timeoutS: cfg.inference.timeout_s,
    tools: toolSpecs(s),
    exec: (name, args) => execTool(s, name, args),
    callback: { url: `${cfg.public_url.replace(/\/$/, '')}/api/v1/ws`, token: s.token },
    isDone: () => !!s.done,
  })
  app.db
    .prepare('INSERT INTO usage (at, round_id, agent, tokens_in, tokens_out, cost_usd, wall_ms) VALUES (?, ?, 1, ?, ?, ?, ?)')
    .run(now(), roundId, result.usage.tokens_in ?? null, result.usage.tokens_out ?? null, result.usage.cost_usd ?? null, result.usage.wall_ms)
  // An agentic backend that never reached the workspace did no review at all — that is an
  // environment fault (wrong public_url, no network), not a clean repository (invariant 6).
  if (s.calls === 0) {
    throw new InferenceError(`the model made no workspace call (is public_url ${cfg.public_url} reachable from the backend?). It said: ${result.text.slice(0, 300)}`, 'missing')
  }
  return result
}

/** Infra, not the repository (invariant 6): the round is blocked, nothing about the findings is concluded. */
function isInfra(err: unknown): err is InferenceError | SandboxError {
  return err instanceof InferenceError || err instanceof SandboxError
}

function infraAlert(app: App, err: unknown) {
  if (err instanceof InferenceError && (err.kind === 'auth' || err.kind === 'missing')) {
    openAlert(app.db, `inference.${err.kind}`, `Inference backend ${err.kind === 'auth' ? 'refused credentials' : 'unreachable'}`, err.message)
  }
  if (err instanceof SandboxError) {
    openAlert(app.db, `sandbox.${err.kind}`, err.kind === 'image' ? 'Sandbox image unavailable' : 'Sandbox unavailable', err.message)
  }
}

function sandboxOf(app: App) {
  const rt = sandboxRuntime(app)
  return rt ? { rt, cfg: app.config.current.sandbox } : undefined
}

/** What the prompt says about the sandbox, when the session has one. */
function sandboxInfo(ws: SessionWorkspace) {
  return isSandbox(ws) ? { install: ws.env.install, test: ws.env.test } : undefined
}

/** What a round holds while it runs; the body sets each as it opens it. */
interface RoundResources {
  worktree?: string
  ws?: SessionWorkspace
  session?: Session
}

/**
 * The lifecycle every round shares: on a throw the round ends blocked (infra) or failed, then the
 * caller's `onError` runs and the error is rethrown; whatever the body opened is closed after.
 */
async function inRound<T>(
  app: App,
  repo: RepoRow,
  roundId: string,
  onError: (err: unknown, infra: boolean) => void,
  body: (r: RoundResources) => Promise<T>,
): Promise<T> {
  const r: RoundResources = {}
  try {
    return await body(r)
  } catch (err) {
    const infra = isInfra(err)
    endRound(app, roundId, { status: infra ? 'blocked' : 'failed', error: (err as Error).message })
    onError(err, infra)
    throw err
  } finally {
    if (r.session) app.sessions.close(r.session)
    await r.ws?.dispose?.()
    if (r.worktree) await app.mirrors.removeWorktree(repo, r.worktree)
  }
}

function existingFindings(app: App, repo: string, check: string) {
  const rows = app.db
    .prepare("SELECT * FROM findings WHERE repo_key = ? AND check_kind = ? AND state IN ('open','dismissed','proposed') ORDER BY updated_at DESC LIMIT 80")
    .all(repo, check) as FindingRow[]
  return rows.map((finding) => ({ finding, dismissedReason: finding.state === 'dismissed' ? lastDismissal(app.db, finding.id)?.reason : undefined }))
}

function renderFindings(rows: FindingRow[]): string {
  if (!rows.length) return '_No findings._'
  return rows.map((f) => `- **${f.title}** — \`${f.anchor}\` · ${f.category} · ${f.severity} · ${f.state}`).join('\n')
}

export async function runRound(app: App, job: QueueRow): Promise<string> {
  const repo = getRepo(app.db, job.repo_key)
  const def = checkOf(app, job.check_kind)
  const head = job.head_sha ?? (await app.mirrors.fetch(repo))
  const scope: 'diff' | 'full' = job.scope === 'diff' && job.base_sha && def.scopes.includes('diff') ? 'diff' : 'full'
  const id = newId('r')
  insertRound(app, { id, repo: repo.key, def, kind: 'round', scope, base: scope === 'diff' ? job.base_sha : null, head, trigger: job.trigger })
  const onError = (err: unknown, infra: boolean) => {
    logEvent(app.db, { level: infra ? 'warn' : 'error', code: infra ? 'ROUND_BLOCKED' : 'ROUND_FAILED', repo: repo.key, message: `${def.kind} round: ${(err as Error).message}`, detail: { round: id } })
    infraAlert(app, err)
  }
  return inRound(app, repo, id, onError, async (r) => {
    const worktree = (r.worktree = await app.mirrors.addWorktree(repo, id, head))
    let ws: SessionWorkspace | undefined
    let recorded
    let narrative: string
    let usage
    if (def.agent !== 'none' || hasImageDetectors(def)) ws = r.ws = await openWorkspace(app, { sessionId: id, worktree, head })
    // Before the model or anything else touches the clone (§10.1: nothing installed yet).
    const det = def.detectors.length ? await detect(def, worktree, ws, sandboxOf(app)) : undefined
    if (def.agent === 'none') {
      recorded = det!.findings
      narrative = det!.notes.map((n) => `- ${n}`).join('\n')
    } else {
      const group = getGroup(app.db, repo.group_id)
      ws ??= r.ws = await openWorkspace(app, { sessionId: id, worktree, head })
      const session = (r.session = app.sessions.open({
        id, kind: 'round', repo, check: def, worktree, ws, head, base: scope === 'diff' ? job.base_sha! : undefined, allowWrite: false,
        timeoutS: app.config.current.inference.timeout_s, runTimeoutS: app.config.current.sandbox.run_timeout_s,
      }))
      const prompt = roundPrompt({ repo, check: def, worktree, sandbox: sandboxInfo(ws), hints: det, scope, base: session.base, head, groupPolicy: group.policy, existing: existingFindings(app, repo.key, def.kind) })
      const result = await drive(app, session, prompt, id)
      usage = result.usage
      recorded = session.findings
      narrative = session.done?.text ?? (result.text || '_The model ended without a report._')
      if (session.done?.status === 'cannot') narrative = `**The model could not complete the review:** ${session.done.text}`
    }
    const rec = await reconcile(app.db, {
      repo: repo.key, check: def.kind, roundId: id, scope, sensitive: def.sensitive === 'always', worktree, commit: head, recorded,
    })
    const touched = rec.ids.length
      ? (app.db.prepare(`SELECT * FROM findings WHERE id IN (${rec.ids.map(() => '?').join(',')})`).all(...rec.ids) as FindingRow[])
      : []
    const summary = `${recorded.length} raised · ${rec.created} new · ${rec.reopened} reopened · ${rec.stillDismissed} still dismissed · ${rec.gone} gone`
    const report = `# ${def.title} — ${scope} round\n\n${repo.key} @ \`${head.slice(0, 10)}\`${scope === 'diff' ? ` (since \`${job.base_sha!.slice(0, 10)}\`)` : ''}\n\n${narrative}\n\n## Findings this round\n\n${renderFindings(touched)}\n\n_${summary}_`
    endRound(app, id, { status: 'done', summary, report, usage })
    logEvent(app.db, { code: 'ROUND_DONE', repo: repo.key, message: `${def.kind} ${scope} round: ${summary}`, detail: { round: id } })
    maybeReport(app, repo, def, { id, scope, summary, fresh: rec.created + rec.reopened })
    maybePropose(app, repo, def)
    return id
  })
}

/**
 * Delivery `report`, whatever the check: the round itself is what a person gets, as an Activity
 * item. One per round that surfaced something (new or reopened findings), plus every full LLM
 * review, whose narrative is worth reading on its own. A newer report supersedes the unread one
 * for the same repo and check, so a daily check does not stack items.
 */
function maybeReport(app: App, repo: RepoRow, def: CheckDef, r: { id: string; scope: 'diff' | 'full'; summary: string; fresh: number }) {
  const s = settingsFor(app, repo, def)
  if (!s.enabled || s.delivery !== 'report') return
  if (r.fresh === 0 && !(r.scope === 'full' && def.agent !== 'none')) return
  app.db
    .prepare(
      `UPDATE activity SET state = 'resolved', resolution = 'superseded', resolved_at = ?
        WHERE kind = 'report' AND state = 'open' AND repo_key = ?
          AND ref_id IN (SELECT id FROM rounds WHERE repo_key = ? AND check_kind = ?)`,
    )
    .run(now(), repo.key, repo.key, def.kind)
  addItem(app.db, { kind: 'report', repo: repo.key, ref: r.id, title: `${def.title} — ${repo.key}`, body: r.summary, sensitive: def.sensitive === 'always' })
}

function proposalCandidates(app: App, repo: string, check: string): FindingRow[] {
  return app.db
    .prepare(
      `SELECT * FROM findings WHERE repo_key = ? AND check_kind = ? AND state = 'open' AND proposal_id IS NULL
         AND (blocked_input IS NULL OR blocked_input != input_hash)
       ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 ELSE 2 END, created_at LIMIT 8`,
    )
    .all(repo, check) as FindingRow[]
}

/** After a round: is there something to fix, and may Lamplighter start fixing it by itself? */
export function maybePropose(app: App, repo: RepoRow, def: CheckDef, foreground = false): 'queued' | string {
  const s = settingsFor(app, repo, def)
  if (!s.enabled) return 'check disabled'
  if (s.delivery === 'report') return 'delivery is report'
  const access = writeAccess(app, repo)
  if (!access.ok) return `blocked: ${access.why}`
  if (!foreground && !s.armed) return 'check not armed'
  const inflight = app.db
    .prepare("SELECT id FROM proposals WHERE repo_key = ? AND check_kind = ? AND state IN ('drafting','validating','ready','held','submitted')")
    .get(repo.key, def.kind)
  if (inflight) return 'a proposal for this check is already in flight'
  if (!foreground && openCount(app.db, repo.key) >= app.config.current.schedule.open_items_per_repo) return 'attention cap reached for this repo'
  if (!proposalCandidates(app, repo.key, def.kind).length) return 'nothing to fix'
  const queued = app.db.prepare("SELECT id FROM queue WHERE job = 'author' AND repo_key = ? AND check_kind = ? AND state IN ('queued','running')").get(repo.key, def.kind)
  if (queued) return 'already queued'
  app.db
    .prepare("INSERT INTO queue (id, job, repo_key, check_kind, scope, foreground, tier, trigger, created_at) VALUES (?, 'author', ?, ?, 'full', ?, 3, ?, ?)")
    .run(newId('q'), repo.key, def.kind, foreground ? 1 : 0, foreground ? 'request' : 'round', now())
  app.kick()
  return 'queued'
}

function commitMessage(def: CheckDef, summary: string, sensitive: boolean, roundId: string, findings: FindingRow[]): string {
  const trailers = `${TRAILER_ROUND}: ${roundId}\n${TRAILER_CHECK}: ${def.kind}`
  // A sensitive fix says nothing about what it fixes (invariant 5).
  if (sensitive) return `chore: maintenance\n\n${trailers}\n`
  const lines = summary.trim().split('\n')
  const title = (lines[0] ?? 'Maintenance').replace(/^#+\s*/, '').slice(0, 72)
  const body = lines.slice(1).join('\n').trim()
  return `${title}\n\n${body ? `${body}\n\n` : ''}Addresses: ${findings.map((f) => f.id).join(', ')}\n\n${trailers}\n`
}

export async function runAuthor(app: App, job: QueueRow): Promise<string | undefined> {
  const repo = getRepo(app.db, job.repo_key)
  const def = checkOf(app, job.check_kind)
  const findings = proposalCandidates(app, repo.key, def.kind)
  if (!findings.length) return undefined
  // Queued before access was lost: drop it rather than author a fix nobody can deliver.
  if (!writeAccess(app, repo).ok) return undefined
  const base = await app.mirrors.fetch(repo)
  const s = settingsFor(app, repo, def)
  const forge = forgeRow(app.db, repo.forge_id)
  const delivery = s.delivery === 'pr' && forge.kind === 'git' ? 'branch' : s.delivery
  const sensitive = def.sensitive === 'always'
  const pid = newId('p')
  const branch = ownBranch(def.kind, sensitive ? 'maintenance' : findings[0]!.title, new Date(), pid)
  const t = now()
  app.db
    .prepare(
      `INSERT INTO proposals (id, repo_key, check_kind, branch, base_sha, state, delivery, sensitive, finding_ids, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'drafting', ?, ?, ?, ?, ?)`,
    )
    .run(pid, repo.key, def.kind, branch, base, delivery, sensitive ? 1 : 0, JSON.stringify(findings.map((f) => f.id)), t, t)
  const mark = app.db.prepare("UPDATE findings SET state = 'proposed', proposal_id = ?, updated_at = ? WHERE id = ?")
  for (const f of findings) mark.run(pid, t, f.id)
  logEvent(app.db, { code: 'PROPOSAL_STARTED', repo: repo.key, message: `${def.kind}: fixing ${findings.length} finding(s)`, detail: { proposal: pid } })

  const roundId = newId('r')
  // An infra failure says nothing about the findings: release them without blocking a retry.
  const onError = (err: unknown, infra: boolean) => {
    infraAlert(app, err)
    failProposal(app, pid, (err as Error).message, { block: !infra })
  }
  const noChange = await inRound(app, repo, roundId, onError, async (r) => {
    insertRound(app, { id: roundId, repo: repo.key, def, kind: 'author', scope: 'full', head: base, proposal: pid, trigger: job.trigger })
    const worktree = (r.worktree = await app.mirrors.addWorktree(repo, roundId, base))
    const ws = (r.ws = await openWorkspace(app, { sessionId: roundId, worktree, head: base }))
    const sb = sandboxOf(app)
    if (sb && isSandbox(ws) && def.fix_tools.length) await installFixTools(sb.rt, sb.cfg, ws, def.fix_tools)
    const session = (r.session = app.sessions.open({
      id: roundId, kind: 'author', repo, check: def, worktree, ws, head: base, allowWrite: true,
      timeoutS: app.config.current.inference.timeout_s, runTimeoutS: app.config.current.sandbox.run_timeout_s,
    }))
    const group = getGroup(app.db, repo.group_id)
    const result = await drive(app, session, authorPrompt({ repo, check: def, worktree, sandbox: sandboxInfo(ws), groupPolicy: group.policy, findings }), roundId)
    // A sandbox's change comes back as a patch and is committed here, by the backend (invariant 1).
    if (isSandbox(ws)) {
      const patch = await ws.exportPatch()
      if (patch) await git(['apply', '--index', '-'], { cwd: worktree, input: patch })
    }
    const status = (await git(['status', '--porcelain'], { cwd: worktree })).trim()
    if (session.done?.status === 'cannot' || !status) {
      const why = session.done?.status === 'cannot' ? session.done.text : 'the session made no change'
      endRound(app, roundId, { status: 'done', summary: `no change: ${why}`, report: why, usage: result.usage })
      failProposal(app, pid, why)
      return true
    }
    const summary = session.done?.text ?? result.text
    const id = commitIdentity(app, repo)
    await git(['add', '-A'], { cwd: worktree })
    await git(['commit', '-q', '-F', '-'], {
      cwd: worktree,
      config: { 'user.name': id.name, 'user.email': id.email, 'commit.gpgsign': 'false' },
      input: commitMessage(def, summary, sensitive, roundId, findings),
    })
    const head = (await git(['rev-parse', 'HEAD'], { cwd: worktree })).trim()
    await git(['update-ref', `refs/heads/${branch}`, head], { gitDir: app.mirrors.gitDir(repo) })
    const patch = await git(['diff', base, head], { cwd: worktree })
    app.db
      .prepare("UPDATE proposals SET state = 'validating', head_sha = ?, summary = ?, patch = ?, updated_at = ? WHERE id = ?")
      .run(head, summary, patch.slice(0, 400_000), now(), pid)
    endRound(app, roundId, { status: 'done', summary: `changed ${status.split('\n').length} file(s)`, report: summary, usage: result.usage })
    return false
  })
  if (noChange) return pid
  await validate(app, getProposal(app.db, pid)!, job.trigger)
  return pid
}

/**
 * The fixer never judges its own work (invariant 2). First the repository's own tests, on base and
 * on the proposal in fresh sandboxes (§7.3 step 1); then a fresh session, which did not write the
 * change, reviews it as a diff. A test that passed on base and fails on the proposal, or any
 * finding the review records — a claimed fix that is not one, or a new problem — fails the
 * proposal (no regression, invariant 3).
 */
export async function validate(app: App, p: ProposalRow, trigger: string): Promise<void> {
  const repo = getRepo(app.db, p.repo_key)
  const def = checkOf(app, p.check_kind)
  const addressed = (JSON.parse(p.finding_ids) as string[])
    .map((id) => app.db.prepare('SELECT * FROM findings WHERE id = ?').get(id) as FindingRow | undefined)
    .filter((f): f is FindingRow => !!f)
  const roundId = newId('r')
  const onError = (err: unknown, infra: boolean) => {
    infraAlert(app, err)
    failProposal(app, p.id, `validation could not run: ${(err as Error).message}`, { block: !infra })
  }
  await inRound(app, repo, roundId, onError, async (r) => {
    insertRound(app, { id: roundId, repo: repo.key, def, kind: 'confirm', scope: 'diff', base: p.base_sha, head: p.head_sha!, proposal: p.id, trigger })
    const tests = await mechanical(app, repo, p.base_sha, p.head_sha!)
    const testsReport = `## Tests\n\n${renderMechanical(tests)}`
    if (!tests.ok) {
      const broken = tests.results.filter((r) => r.regression).map((r) => r.command)
      const verdict = `${broken.map((c) => `\`${c}\``).join(', ')} pass${broken.length === 1 ? 'es' : ''} on the base and fail${broken.length === 1 ? 's' : ''} on the proposal`
      app.db.prepare('UPDATE proposals SET validation = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ok: false, round: roundId, verdict, remaining: [], mechanical: tests }), now(), p.id)
      endRound(app, roundId, { status: 'done', summary: 'tests regressed', report: `# Validation of ${p.id}\n\n${verdict}\n\n${testsReport}` })
      failProposal(app, p.id, `validation: ${verdict}`)
      return
    }
    // The proposal's own check, plus cve whatever the kind: a refactor can pull in a dependency.
    const cve = app.checks.get('cve')
    const scanned = [def, ...(cve && cve.kind !== def.kind ? [cve] : [])]
    const scan = await scanCheck(app, repo, scanned, p.base_sha, p.head_sha!, addressed.map((f) => ({ check: f.check_kind, category: f.category, anchor: f.anchor })))
    const scanReport = `## Scanners\n\n${renderScan(scan)}`
    if (!scan.ok) {
      const verdict = [scan.unfixed.length ? `still reported: ${scan.unfixed.join('; ')}` : '', scan.introduced.length ? `new: ${scan.introduced.join('; ')}` : ''].filter(Boolean).join(' · ')
      app.db.prepare('UPDATE proposals SET validation = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ok: false, round: roundId, verdict, remaining: [], mechanical: tests, scan }), now(), p.id)
      endRound(app, roundId, { status: 'done', summary: 'scanners disagree', report: `# Validation of ${p.id}\n\n${verdict}\n\n${testsReport}\n\n${scanReport}` })
      failProposal(app, p.id, `validation: ${verdict}`)
      return
    }
    const worktree = (r.worktree = await app.mirrors.addWorktree(repo, roundId, p.head_sha!))
    const ws = (r.ws = await openWorkspace(app, { sessionId: roundId, worktree, head: p.head_sha! }))
    const session = (r.session = app.sessions.open({
      id: roundId, kind: 'confirm', repo, check: def, worktree, ws, base: p.base_sha, head: p.head_sha!, allowWrite: false,
      timeoutS: app.config.current.inference.timeout_s, runTimeoutS: app.config.current.sandbox.run_timeout_s,
    }))
    const result = await drive(app, session, confirmPrompt({ repo, check: def, sandbox: sandboxInfo(ws), base: p.base_sha, head: p.head_sha!, addressed }), roundId)
    const remaining = session.findings
    const ok = remaining.length === 0 && session.done?.status !== 'cannot'
    const verdict = session.done?.text ?? result.text
    const validation = { ok, round: roundId, verdict, remaining, mechanical: tests, scan }
    app.db.prepare('UPDATE proposals SET validation = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(validation), now(), p.id)
    endRound(app, roundId, {
      status: 'done',
      summary: ok ? 'validated' : `${remaining.length} problem(s) remain`,
      report: `# Validation of ${p.id}\n\n${verdict}\n\n${remaining.map((f) => `- **${f.title}** (${f.category} @ ${f.anchor})\n  ${f.body}`).join('\n')}\n\n${testsReport}\n\n${scanReport}`,
      usage: result.usage,
    })
    if (!ok) {
      failProposal(app, p.id, `validation: ${remaining.map((f) => f.title).join('; ') || verdict}`)
      return
    }
    app.db.prepare("UPDATE proposals SET state = 'ready', updated_at = ? WHERE id = ?").run(now(), p.id)
    logEvent(app.db, { code: 'PROPOSAL_READY', repo: repo.key, message: `${def.kind} proposal validated`, detail: { proposal: p.id } })
    await afterReady(app, p.id)
  })
}
