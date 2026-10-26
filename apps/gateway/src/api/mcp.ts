/** MCP 配置管理路由（仅 admin）。 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { mcpServerConfigSchema, type McpServerDto } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthGuards } from '../auth/guard.js'
import { conflict, notFound, parseInput } from '../http/errors.js'

const mcpParams = z.object({ id: z.string().min(1).max(64) })

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  const admin = { preHandler: [guards.authenticate, guards.requireAdmin] }

  app.get('/api/mcp', admin, async (_request, reply) => {
    const items = ctx.repos.mcp.list()
    reply.send({ total: items.length, items })
  })

  app.get('/api/mcp/:id', admin, async (request, reply) => {
    const { id } = parseInput(mcpParams, request.params, '路径参数')
    const server = ctx.repos.mcp.get(id)
    if (server === undefined) throw notFound(`MCP 服务器不存在: ${id}`)
    reply.send(server)
  })

  app.post('/api/mcp', admin, async (request, reply) => {
    const body = parseInput(mcpServerConfigSchema, request.body, 'MCP 配置')
    if (ctx.repos.mcp.get(body.id) !== undefined) throw conflict(`MCP 服务器已存在: ${body.id}`)
    reply.status(201).send(ctx.repos.mcp.insert(body))
  })

  app.put('/api/mcp/:id', admin, async (request, reply) => {
    const { id } = parseInput(mcpParams, request.params, '路径参数')
    const body = parseInput(mcpServerConfigSchema, request.body, 'MCP 配置')
    if (body.id !== id) throw conflict('路径 id 与请求体 id 不一致')
    const updated = ctx.repos.mcp.update(id, body)
    if (updated === undefined) throw notFound(`MCP 服务器不存在: ${id}`)
    reply.send(updated)
  })

  app.delete('/api/mcp/:id', admin, async (request, reply) => {
    const { id } = parseInput(mcpParams, request.params, '路径参数')
    if (!ctx.repos.mcp.remove(id)) throw notFound(`MCP 服务器不存在: ${id}`)
    reply.send({ ok: true })
  })

  app.post('/api/mcp/:id/test', admin, async (request, reply) => {
    requireAuth(request)
    const { id } = parseInput(mcpParams, request.params, '路径参数')
    const server: McpServerDto | undefined = ctx.repos.mcp.get(id)
    if (server === undefined) throw notFound(`MCP 服务器不存在: ${id}`)
    const result = await ctx.probeMcp(server)
    if (result.ok) ctx.toolCatalog.rememberDiscoveredTools(server.id, result.tools)
    reply.send(result)
  })
}
