import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CheckDef } from '../checks/index.js'
import type { FindingRow } from '../findings/index.js'
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

function policyBlock(groupPolicy: string, repoPolicy: string): string {
  const p = [groupPolicy.trim() && `Group policy:\n${groupPolicy.trim()}`, repoPolicy.trim() && `Repository policy:\n${repoPolicy.trim()}`].filter(Boolean)
  return p.length ? `## Policy (the operator's rules — they win over general best practice)\n\n${p.join('\n\n')}` : ''
}

function findingLine(f: FindingRow, dismissedReason?: string): string {
  const extra = f.state === 'dismissed' ? ` — DISMISSED by the operator: "${dismissedReason ?? ''}"` : ''
  return `- [${f.id}] (${f.state}, ${f.severity}) ${f.category} @ ${f.anchor}: ${f.title}${extra}`
}

export interface RoundPromptArgs {
  repo: RepoRow
  check: CheckDef
  worktree: string
  sandbox?: SandboxInfo
  scope: 'diff' | 'full'
  base?: string
  head: string
  groupPolicy: string
  existing: { finding: FindingRow; dismissedReason?: string }[]
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
        'Do not re-record a DISMISSED finding unless what it is about has materially changed; if you do, pass its id.',
        '',
        ...a.existing.map((e) => findingLine(e.finding, e.dismissedReason)),
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
