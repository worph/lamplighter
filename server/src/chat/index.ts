import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { App } from '../context.js'
import { now } from '../db/index.js'
import { driverFor, extractJson } from '../inference/index.js'
import { ADMIN_TOOLS, adminTool, asText, jsonSchema } from '../tools/admin.js'
import { getSetting, setSetting } from '../settings.js'

/**
 * The administrator chat. Lamplighter owns the loop and the tools; the model only picks the next
 * tool, one per round, answering in JSON. Every step is a stored row, and the prompt is rebuilt
 * from rows each round (Touchstone/Newsdesk's chat/loop.ts) — so what the operator sees and what
 * the model was shown cannot disagree. Works with any driver: it needs text in, text out.
 */

const MAX_CALLS = 8
/** The most of a stored tool result replayed to the model in the prompt. */
const RESULT_CHARS = 6000
/** The most of a tool result kept in the stored row. */
const STORED_RESULT_CHARS = 20_000
/** Time allowed for one model answer in a chat turn. */
const CHAT_TURN_TIMEOUT_S = 240
const HISTORY = 24

export interface ChatMessage {
  id: number
  thread_id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  tool: string | null
  pending: string | null
  at: string
}

interface Pending {
  tool: string
  input: Record<string, unknown>
  word: string
  done?: boolean
}

const template = readFileSync(fileURLToPath(new URL('./prompt.md', import.meta.url)), 'utf8')

export function threadId(app: App): string {
  return getSetting(app.db, 'chat_thread') ?? 'main'
}

export function newThread(app: App): string {
  const id = `t${Date.now().toString(36)}`
  setSetting(app.db, 'chat_thread', id)
  return id
}

export function messages(app: App, thread = threadId(app)): ChatMessage[] {
  return app.db.prepare('SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY id').all(thread) as ChatMessage[]
}

function add(app: App, thread: string, role: ChatMessage['role'], content: string, tool?: string, pending?: Pending): void {
  app.db
    .prepare('INSERT INTO chat_messages (thread_id, role, content, tool, pending, at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(thread, role, content, tool ?? null, pending ? JSON.stringify(pending) : null, now())
}

function catalogue(): string {
  return ADMIN_TOOLS.map((t) => `- ${t.name}${t.confirm ? ' (DECISIVE)' : ''}: ${t.description}\n  input: ${JSON.stringify(jsonSchema(t).properties ?? {})}`).join('\n')
}

function history(rows: ChatMessage[]): string {
  return rows
    .slice(-HISTORY)
    .map((m) => (m.role === 'tool' ? `[tool ${m.tool} result]\n${m.content.slice(0, RESULT_CHARS)}` : `[${m.role}]\n${m.content}`))
    .join('\n\n')
}

export async function runTurn(app: App, text: string): Promise<ChatMessage[]> {
  const thread = threadId(app)
  const before = messages(app, thread).length
  add(app, thread, 'user', text)
  const driver = driverFor(app.config.current, app.db)
  for (let i = 0; i < MAX_CALLS; i++) {
    const prompt = template.replace('{{CATALOGUE}}', catalogue()).replace('{{HISTORY}}', history(messages(app, thread)))
    let answer: { say?: string; call?: { tool: string; input?: Record<string, unknown> } | null } | undefined
    try {
      const r = await driver.complete({ prompt, timeoutS: CHAT_TURN_TIMEOUT_S })
      answer = extractJson(r.text)
      if (!answer) {
        add(app, thread, 'assistant', r.text.trim() || '(no answer)')
        break
      }
    } catch (err) {
      add(app, thread, 'assistant', `I could not reach the inference backend: ${(err as Error).message}`)
      break
    }
    const call = answer.call
    if (!call) {
      add(app, thread, 'assistant', answer.say?.trim() || '(nothing to say)')
      break
    }
    const t = adminTool(call.tool)
    if (!t) {
      add(app, thread, 'tool', `error: no tool named ${call.tool}`, call.tool)
      continue
    }
    const parsed = t.schema.safeParse(call.input ?? {})
    if (!parsed.success) {
      add(app, thread, 'tool', `error: bad input — ${parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`, t.name)
      continue
    }
    if (t.confirm) {
      const word = t.confirm(parsed.data)
      add(app, thread, 'assistant', answer.say?.trim() || `I would like to run **${t.title}**.`, t.name, { tool: t.name, input: parsed.data, word })
      break
    }
    if (answer.say?.trim()) add(app, thread, 'assistant', answer.say.trim())
    try {
      add(app, thread, 'tool', asText(await t.run(app, parsed.data, 'chat')).slice(0, STORED_RESULT_CHARS), t.name)
    } catch (err) {
      add(app, thread, 'tool', `error: ${(err as Error).message}`, t.name)
    }
    if (i === MAX_CALLS - 1) add(app, thread, 'assistant', 'I stopped after several tool calls without a final answer — ask me to continue if needed.')
  }
  return messages(app, thread).slice(before)
}

/** The operator typed the confirmation word under a decisive proposal: run it. */
export async function confirm(app: App, messageId: number, typed: string): Promise<ChatMessage[]> {
  const row = app.db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(messageId) as ChatMessage | undefined
  if (!row?.pending) throw new Error('nothing to confirm')
  const p = JSON.parse(row.pending) as Pending
  if (p.done) throw new Error('already confirmed')
  if (typed.trim() !== p.word) throw new Error(`type "${p.word}" exactly to confirm`)
  const t = adminTool(p.tool)!
  app.db.prepare('UPDATE chat_messages SET pending = ? WHERE id = ?').run(JSON.stringify({ ...p, done: true }), messageId)
  const before = messages(app, row.thread_id).length
  try {
    const out = asText(await t.run(app, p.input as never, 'chat (confirmed)'))
    add(app, row.thread_id, 'tool', out, t.name)
    add(app, row.thread_id, 'assistant', `Done — **${t.title}** ran.`)
  } catch (err) {
    add(app, row.thread_id, 'tool', `error: ${(err as Error).message}`, t.name)
    add(app, row.thread_id, 'assistant', `**${t.title}** failed: ${(err as Error).message}`)
  }
  return messages(app, row.thread_id).slice(before)
}
