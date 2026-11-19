import { randomBytes, randomUUID } from 'node:crypto'
import type { CheckDef } from '../checks/index.js'
import type { RepoRow } from '../repos/registry.js'

export type SessionKind = 'round' | 'author' | 'confirm'

export interface RecordedFinding {
  category: string
  anchor: string
  title: string
  body: string
  severity: 'critical' | 'major' | 'minor'
  existing_id?: string
}

/**
 * One model session against one worktree. Lives in memory only: the token is minted here, handed
 * to the model, and dies with the session (Touchstone's workshop session, services/workshop.ts).
 */
export interface Session {
  id: string
  /** A UUID — claude-code's sessionId must be one. */
  agentSessionId: string
  token: string
  kind: SessionKind
  repo: RepoRow
  check: CheckDef
  worktree: string
  /** Diff scope: the range under review. */
  base?: string
  head: string
  allowWrite: boolean
  expiresAt: number
  findings: RecordedFinding[]
  written: Set<string>
  calls: number
  done: { status: 'finished' | 'cannot'; text: string } | null
}

export class SessionRegistry {
  private byToken = new Map<string, Session>()

  open(init: Omit<Session, 'token' | 'agentSessionId' | 'findings' | 'written' | 'calls' | 'done' | 'expiresAt'> & { timeoutS: number }): Session {
    const { timeoutS, ...rest } = init
    const s: Session = {
      ...rest,
      token: randomBytes(24).toString('base64url'),
      agentSessionId: randomUUID(),
      expiresAt: Date.now() + (timeoutS + 600) * 1000,
      findings: [],
      written: new Set(),
      calls: 0,
      done: null,
    }
    this.byToken.set(s.token, s)
    return s
  }

  /** The session a token names, if it is live. A finished session refuses further calls. */
  lookup(token: string | undefined): Session | undefined {
    if (!token) return undefined
    const s = this.byToken.get(token)
    if (!s) return undefined
    if (Date.now() > s.expiresAt) {
      this.byToken.delete(token)
      return undefined
    }
    return s
  }

  close(s: Session): void {
    this.byToken.delete(s.token)
  }

  active(): Session[] {
    return [...this.byToken.values()]
  }
}
