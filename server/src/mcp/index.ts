import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { App } from '../context.js'
import { SETTING, getSetting } from '../settings.js'
import { ADMIN_TOOLS, asText } from '../tools/admin.js'
import { execTool, WORKSPACE_TOOLS } from '../tools/workspace.js'

export const VERSION = '0.2.0'

const ADMIN_INSTRUCTIONS = `Lamplighter keeps a fleet of git repositories maintained: it runs checks (docs, cve, deps,
dead-code, refactor, quality, patterns, architecture, security) as rounds, records findings, and prepares
validated fixes that a person approves in Lamplighter's Activity page.

This surface reads the fleet, configures it, requests rounds or fixes, and dismisses findings with a
reason. It cannot approve, merge, push or revert anything — those decisions belong to a person in the
Activity page or the administrator chat. request_round and request_fix return at once; the work runs
when a slot is free (see get_schedule).`

function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Stateless Streamable HTTP: one server and transport per request, closed with the response. */
async function serve(req: FastifyRequest, reply: FastifyReply, build: () => McpServer) {
  const server = build()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  reply.raw.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  reply.hijack()
  await transport.handleRequest(req.raw, reply.raw, req.body)
}

function text(t: string, isError = false) {
  return { content: [{ type: 'text' as const, text: t }], ...(isError ? { isError: true } : {}) }
}

export function registerMcp(f: FastifyInstance, app: App): void {
  // ── admin ──────────────────────────────────────────────────────────────────────────────
  f.post('/mcp/admin', async (req, reply) => {
    const token = getSetting(app.db, SETTING.adminMcpToken) ?? ''
    const given = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!token || !secretEquals(given, token)) {
      return reply.code(401).send({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null })
    }
    await serve(req, reply, () => {
      const server = new McpServer({ name: 'lamplighter', version: VERSION }, { instructions: ADMIN_INSTRUCTIONS })
      for (const t of ADMIN_TOOLS.filter((x) => x.scope === 'both')) {
        server.registerTool(
          t.name,
          { title: t.title, description: t.description, inputSchema: t.schema.shape, annotations: { readOnlyHint: !!t.readOnly } },
          async (input: Record<string, unknown>) => {
            try {
              return text(asText(await t.run(app, input as never, 'mcp')))
            } catch (err) {
              return text((err as Error).message, true)
            }
          },
        )
      }
      return server
    })
  })

  // ── workspace (the session callback, for agentic backends that speak MCP) ────────────────
  f.post('/api/v1/mcp/workspace', async (req, reply) => {
    await serve(req, reply, () => {
      const server = new McpServer(
        { name: 'lamplighter-workspace', version: VERSION },
        { instructions: 'One review or fixing session on one repository. Every tool needs the session_token from your instructions.' },
      )
      for (const t of WORKSPACE_TOOLS) {
        const shape = (t.schema as z.ZodObject<z.ZodRawShape>).shape
        server.registerTool(t.name, { description: t.description, inputSchema: { session_token: z.string(), ...shape } }, async (input: Record<string, unknown>) => {
          const { session_token, ...args } = input
          const s = app.sessions.lookup(session_token as string)
          if (!s) return text('unknown or expired session_token', true)
          try {
            return text(await execTool(s, t.name, args))
          } catch (err) {
            return text((err as Error).message, true)
          }
        })
      }
      return server
    })
  })
  for (const p of ['/mcp/admin', '/api/v1/mcp/workspace']) {
    f.get(p, async (_req, reply) => reply.code(405).send({ error: 'POST only (stateless Streamable HTTP)' }))
  }

  // ── workspace over plain HTTP: what the prompt tells a curl-wielding agent to use ─────────
  f.post('/api/v1/ws/:tool', async (req, reply) => {
    const s = app.sessions.lookup(req.headers['x-session-token'] as string | undefined)
    if (!s) return reply.code(401).type('text/plain').send('unknown or expired session token')
    try {
      const out = await execTool(s, (req.params as { tool: string }).tool, req.body ?? {})
      return reply.type('text/plain; charset=utf-8').send(out)
    } catch (err) {
      return reply.code(400).type('text/plain; charset=utf-8').send(`error: ${(err as Error).message}`)
    }
  })
}
