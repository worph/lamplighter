import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckDef } from '../checks/index.js'
import type { DetectorResult } from '../checks/detectors/index.js'
import type { FindingRow } from '../findings/index.js'
import type { Precedent } from '../admission/index.js'
import type { RepoRow } from '../repos/registry.js'

/**
 * Prompts are driver-agnostic: they say what to do and with which tools *by name*. How the tools
 * are reached is the driver's business (an HTTP section appended for agentic backends, function
 * schemas for tool-calling ones).
 */

const CONTEXT_FILES = ['LAMPLIGHTER.md', 'CLAUDE.md']
const CONTEXT_CHARS = 8000

function repoContext(worktree: string): string {
  const parts: string[] = []
  for (const f of CONTEXT_FILES) {
    const p = join(worktree, f)
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    parts.push(`### ${f} (from the repository)\n\n${text.length > CONTEXT_CHARS ? `${text.slice(0, CONTEXT_CHARS)}\n… (truncated; read_file for the rest)` : text}`)
  }
  return parts.join('\n\n')
}

/** The session's sandbox, as the prompt describes it. Absent: the model has file tools only (v1). */
export interface SandboxInfo {
  install: string[]
  test: string[]
}

function sandboxBlock(sb: SandboxInfo | undefined, writes: boolean): string {
  if (!sb) return ''
  const list = (cmds: string[], none: string) => (cmds.length ? cmds.map((c) => `\`${c}\``).join(', then ') : none)
  return [
    '## The sandbox',
    '',
    'This session runs in a sandbox: a container with a clone of the repository (with its history, without a remote) and the `run` tool, which runs a shell command at the repository root.',
    '- Toolchains come from mise, at the versions the repository names (.nvmrc, package.json engines, .python-version, go.mod…): `mise install` before the first build or test.',
    `- Dependencies are not installed yet. Install: ${list(sb.install, 'nothing detected — read the repository to find out')}.`,
    `- Tests: ${list(sb.test, 'none detected')}.`,
    writes
      ? '- Only changes inside the repository are kept, and dependency folders (node_modules, .venv) never are. A change that needs a package manager (a lockfile refresh, a version bump) can be made here: run it.'
      : '- Nothing you change here is kept: this session only reads and reports. Run what helps you judge (tests, `--help`, a build).',
  ].join('\n')
}

const MAX_HINTS = 60

/** Scanner output for a review check: leads to verify, not findings to copy. */
function hintsBlock(h: DetectorResult | undefined): string {
  if (!h || (!h.findings.length && !h.notes.length)) return ''
  return [
    '## Scanner results (hints)',
    '',
    'Deterministic scanners ran on this commit before you. Treat each result as a lead: check it in the code, record it only if it is real, and say in your report which you rejected.',
    '',
    ...h.findings.slice(0, MAX_HINTS).map((f) => `- ${f.title} — \`${f.anchor}\` (${f.severity})`),
    ...(h.findings.length > MAX_HINTS ? [`- … and ${h.findings.length - MAX_HINTS} more`] : []),
    ...h.notes.map((n) => `- _${n}_`),
  ].join('\n')
}

function policyBlock(groupPolicy: string, repoPolicy: string): string {
  const p = [groupPolicy.trim() && `Group policy:\n${groupPolicy.trim()}`, repoPolicy.trim() && `Repository policy:\n${repoPolicy.trim()}`].filter(Boolean)
  return p.length ? `## Policy (the operator's rules — they win over general best practice)\n\n${p.join('\n\n')}` : ''
}

const PUT_ASIDE: Record<string, string> = { dismissed: 'DISMISSED', deferred: 'NOT NOW', declined: 'DECLINED' }

function findingLine(f: FindingRow, reason?: string): string {
  const extra = PUT_ASIDE[f.state] ? ` — ${PUT_ASIDE[f.state]}: "${reason ?? ''}"` : ''
  return `- [${f.id}] (${f.state}, ${f.severity}) ${f.category} @ ${f.anchor}: ${f.title}${extra}`
}

export interface RoundPromptArgs {
  repo: RepoRow
  check: CheckDef
  worktree: string
  sandbox?: SandboxInfo
  hints?: DetectorResult
  scope: 'diff' | 'full'
  base?: string
  head: string
  groupPolicy: string
  existing: { finding: FindingRow; reason?: string }[]
}

export function roundPrompt(a: RoundPromptArgs): string {
  const scope =
    a.scope === 'diff' && a.base
      ? `This is a DIFF review: only the changes in ${a.base.slice(0, 10)}..${a.head.slice(0, 10)} are in scope (call git_diff first). Look at surrounding code only to judge the change.`
      : `This is a FULL review of the repository at ${a.head.slice(0, 10)}.`
  const existing = a.existing.length
    ? [
        '## Findings already known for this check',
        '',
        'When you find one of these again, record it with its id as `existing_id` (even if your wording differs).',
        'A DISMISSED, NOT NOW or DECLINED finding was put aside on purpose: record it again only with its id, never as a new one.',
        '',
        ...a.existing.map((e) => findingLine(e.finding, e.reason)),
      ].join('\n')
    : ''
  return [
    `You are Lamplighter's reviewer for the "${a.check.title}" check on the repository ${a.repo.owner ? `${a.repo.owner}/` : ''}${a.repo.name} (branch ${a.repo.line}).`,
    'You only READ the repository. You make no changes.',
    '',
    `## The check\n\n${a.check.prompt}`,
    '',
    `## Scope\n\n${scope}`,
    '',
    policyBlock(a.groupPolicy, a.repo.policy),
    repoContext(a.worktree),
    sandboxBlock(a.sandbox, false),
    hintsBlock(a.hints),
    existing,
    '',
    '## How to work',
    '',
    `1. Explore with list_files, read_file, grep, git_log (and git_diff for a diff review)${a.sandbox ? '; use run to check what reading cannot settle' : ''}.`,
    `2. Record each real problem with record_finding. category must be one of: ${a.check.categories.join(', ')}.`,
    '   severity: critical | major | minor. anchor: the repository-relative file path (optionally path#symbol).',
    '   The body says what is wrong, where (quote it), and what the fix would be. No speculation: if you cannot point at it, do not record it.',
    '3. Recording nothing is a normal outcome for a healthy repository.',
    '4. Call finish with a short markdown report: what you looked at, what you found, what you deliberately did not report.',
  ]
    .filter((s) => s !== '')
    .join('\n')
}

export interface AuthorPromptArgs {
  repo: RepoRow
  check: CheckDef
  worktree: string
  sandbox?: SandboxInfo
  groupPolicy: string
  findings: FindingRow[]
}

export function authorPrompt(a: AuthorPromptArgs): string {
  return [
    `You are Lamplighter's maintainer for the "${a.check.title}" check on ${a.repo.owner ? `${a.repo.owner}/` : ''}${a.repo.name} (branch ${a.repo.line}).`,
    'Your job is to FIX the findings below by editing files in the workspace. Somebody else will validate your change, so do not judge it yourself — just make it correct and minimal.',
    '',
    `## The check\n\n${a.check.prompt}`,
    '',
    policyBlock(a.groupPolicy, a.repo.policy),
    repoContext(a.worktree),
    sandboxBlock(a.sandbox, true),
    '',
    '## Findings to fix',
    '',
    ...a.findings.map((f) => `### [${f.id}] ${f.title}\n${f.category} @ ${f.anchor} (${f.severity})\n\n${f.body}`),
    '',
    '## How to work',
    '',
    '1. Read the code around each finding before changing it.',
    '2. Change files with write_file (full new content) and delete_file. Change only what the findings require.',
    a.sandbox
      ? '3. Check your edits with git_diff, and run the tests: a change that breaks a test passing before it will be rejected.'
      : '3. Check your edits with git_diff.',
    a.sandbox
      ? '4. If a finding cannot be fixed here (it needs a migration, a decision, a credential), leave it and say so in the summary.'
      : '4. If a finding cannot be fixed with file edits alone (it needs a package manager, a migration, a decision), leave it and say so in the summary.',
    '5. Call finish with the change description: the first line is a short title (imperative, under 70 characters), then a blank line, then what changed and why, per finding id.',
    '   If you changed nothing at all, call cannot with the reason instead.',
  ]
    .filter((s) => s !== '')
    .join('\n')
}

export interface ConfirmPromptArgs {
  repo: RepoRow
  check: CheckDef
  sandbox?: SandboxInfo
  base: string
  head: string
  addressed: FindingRow[]
}

export function confirmPrompt(a: ConfirmPromptArgs): string {
  return [
    `You are Lamplighter's validator for the "${a.check.title}" check on ${a.repo.owner ? `${a.repo.owner}/` : ''}${a.repo.name}.`,
    `A change (${a.base.slice(0, 10)}..${a.head.slice(0, 10)}, see git_diff) claims to fix the findings below. You did not write it. Decide whether it does, without trusting its description.`,
    '',
    `## The check\n\n${a.check.prompt}`,
    '',
    '## Findings the change claims to fix',
    '',
    ...a.addressed.map((f) => `- [${f.id}] ${f.category} @ ${f.anchor}: ${f.title}`),
    '',
    sandboxBlock(a.sandbox, false),
    '',
    '## How to work',
    '',
    '1. Call git_diff, then read the changed files and whatever they interact with.',
    '2. For each finding above that is NOT fully fixed, record_finding with its id as existing_id and say what remains.',
    `3. For any NEW problem the change introduces that this check is about (it broke something, removed something still used, documented something false), record_finding without an id. category must be one of: ${a.check.categories.join(', ')}.`,
    '4. Record nothing when the change is correct. Then call finish with a short verdict.',
  ].join('\n')
}

export interface ArbiterCandidate {
  finding: FindingRow
  lean: 'admit' | 'defer'
}

export interface ArbiterPromptArgs {
  repo: RepoRow
  worktree: string
  groupPolicy: string
  candidates: ArbiterCandidate[]
  precedents: Precedent[]
  /** Per check: findings already admitted and not landed. */
  backlog: Record<string, number>
  inFlight: number
  openItems: number
  openItemsCap: number
}

export function arbiterPrompt(a: ArbiterPromptArgs): string {
  const backlog = Object.entries(a.backlog).filter(([, n]) => n > 0)
  return [
    `You are Lamplighter's arbiter for ${a.repo.owner ? `${a.repo.owner}/` : ''}${a.repo.name} (branch ${a.repo.line}).`,
    "Reviews of separate checks raised the findings below, each without seeing the others. You decide which of them become work: a fix Lamplighter will write, validate and deliver for a person to review. You see the whole repository, its policy and what was decided before. You change nothing and record no findings.",
    '',
    policyBlock(a.groupPolicy, a.repo.policy),
    repoContext(a.worktree),
    '',
    '## The backlog',
    '',
    backlog.length ? backlog.map(([k, n]) => `- ${k}: ${n} admitted, not landed yet`).join('\n') : '- nothing admitted is waiting',
    `- proposals in flight: ${a.inFlight}`,
    `- items awaiting a person: ${a.openItems} (Lamplighter starts no new proposal for this repo past ${a.openItemsCap})`,
    '',
    '## Precedents',
    '',
    a.precedents.length
      ? [
          'Past decisions on similar findings, closest first. A person\'s decision (by: user) outweighs the arbiter\'s own (by: arbiter). Cite the ids you rely on.',
          '',
          ...a.precedents.map((p) => `- [${p.id}] by ${p.by}, ${p.at.slice(0, 10)}: ${p.decision.toUpperCase()} "${p.title}" (${p.check_kind}/${p.category}${p.repo_key === a.repo.key ? '' : `, ${p.repo_key}`}) — ${p.rationale}`),
        ].join('\n')
      : '_None yet: judge from the policy and the code._',
    '',
    '## Candidates',
    '',
    ...a.candidates.map(({ finding: f, lean }) =>
      `### [${f.id}] ${f.title}\n${f.check_kind} · ${f.category} @ ${f.anchor} · ${f.severity}${f.sensitive ? ' · SENSITIVE' : ''} · this check leans ${lean.toUpperCase()}\n\n${f.body.slice(0, 1500)}`),
    '',
    '## How to decide',
    '',
    '- admit: worth a change now, and the backlog can take it.',
    '- defer (not now): plausible, but too large, premature, overlapping other admitted work, or past what the backlog can take. It stays visible, and is judged again when the code, the policy or a person\'s decision changes.',
    '- decline: wrong, a matter of taste the policy does not ask for, or against the policy. A sensitive finding is never declined: defer it.',
    "- Start from the check's lean and the precedents; depart from them only for a reason you can state.",
    '- Read the code (list_files, read_file, grep, git_log) when you need to judge how large a change would be.',
    '',
    '## How to work',
    '',
    '1. Call decide once for every candidate: finding_id, decision, a rationale of one or two sentences, and the precedent ids you relied on.',
    '2. Then call finish with a short summary of what you admitted and what you put aside, and why.',
  ]
    .filter((s) => s !== '')
    .join('\n')
}
