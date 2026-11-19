import type { Checks } from './checks/index.js'
import type { ConfigStore } from './config/index.js'
import type { Db } from './db/index.js'
import type { Env } from './env.js'
import type { Mirrors } from './repos/mirror.js'
import type { SessionRegistry } from './sessions/session.js'
import type { ScheduleView } from './scheduler/index.js'

/** Everything a route, a job or a tool needs, built once in index.ts. */
export interface App {
  db: Db
  env: Env
  config: ConfigStore
  checks: Checks
  mirrors: Mirrors
  sessions: SessionRegistry
  /** Ask the scheduler to look now rather than at the next tick. */
  kick(): void
  /** Fetch one repo now (webhook, a person's request). */
  pollNow(repoKey: string): Promise<void>
  schedule(): ScheduleView
}
