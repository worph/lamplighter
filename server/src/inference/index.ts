import type { Config } from '../config/index.js'
import type { Db } from '../db/index.js'
import { SETTING, getSetting } from '../settings.js'
import { createClaudeCodeDriver } from './claude-code.js'
import { createOpenAiDriver } from './openai.js'
import type { Driver } from './types.js'

/** Built per use from the live config, so a Settings change applies to the next session. */
export function driverFor(config: Config, db: Db): Driver {
  const inf = config.inference
  const bearer = getSetting(db, SETTING.inferenceBearer) || undefined
  if (inf.driver === 'openai') {
    return createOpenAiDriver({ url: inf.url, model: inf.model, bearer, maxRounds: inf.max_tool_rounds })
  }
  return createClaudeCodeDriver({ url: inf.url, tool: inf.tool, via: inf.via, bearer, workdir: inf.workdir || undefined })
}

/** The first JSON object in a text answer (models wrap JSON in prose and fences). */
export function extractJson<T = unknown>(text: string): T | undefined {
  for (let i = text.indexOf('{'); i !== -1; i = text.indexOf('{', i + 1)) {
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') inStr = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1)) as T
          } catch {
            break
          }
        }
      }
    }
  }
  return undefined
}
