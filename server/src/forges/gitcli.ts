import { execFile } from 'node:child_process'

export interface GitOptions {
  cwd?: string
  gitDir?: string
  /** `-c key=value` pairs, e.g. an http.extraHeader carrying the forge credential. */
  config?: Record<string, string>
  timeoutMs?: number
  input?: string
}

export class GitError extends Error {
  constructor(message: string, readonly stderr: string, readonly code: number | null) {
    super(message)
    this.name = 'GitError'
  }
}

/** Never let git prompt: a prompt in a server process is a hang. */
const BASE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '/bin/false',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
  GIT_CONFIG_NOSYSTEM: '1',
  LANG: 'C',
}

export function git(args: string[], opts: GitOptions = {}): Promise<string> {
  const pre: string[] = []
  // Worktrees and mirrors are owned by whoever runs us; a bind mount owned by another uid would
  // otherwise trip "dubious ownership".
  pre.push('-c', 'safe.directory=*')
  for (const [k, v] of Object.entries(opts.config ?? {})) pre.push('-c', `${k}=${v}`)
  if (opts.gitDir) pre.push('--git-dir', opts.gitDir)
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      [...pre, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...BASE_ENV },
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : null
          // Never echo the credential back into a log line.
          const safe = redact(`git ${args[0]} failed: ${stderr || err.message}`)
          reject(new GitError(safe.trim(), redact(stderr), code))
        } else resolve(stdout)
      },
    )
    if (opts.input !== undefined) child.stdin?.end(opts.input)
  })
}

export function redact(s: string): string {
  return s.replace(/(Authorization: )[^\s'"]+( [^\s'"]+)?/gi, '$1[redacted]').replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//[redacted]@')
}
