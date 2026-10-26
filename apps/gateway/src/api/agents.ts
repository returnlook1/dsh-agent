/** Agent / 目录路由。 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  createAgentRequestSchema,
  type AgentDetail,
  type AgentSummary,
  type AgentVersionDto,
  type CreateSessionRequest,
  type SessionDto,
  type ToolDescriptor,
  updateAgentRequestSchema,
} from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthGuards } from '../auth/guard.js'
import { parseInput } from '../http/errors.js'

const idParams = z.object({ id: z.string().min(1).max(64) })
const createSessionSchema = z.object({ title: z.string().max(200).optional() }).default({})

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  app.get('/api/agents', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const items: AgentSummary[] = ctx.services.agents.list(user)
    reply.send({ total: items.length, items })
  })

  app.post('/api/agents', { preHandler: [guards.authenticate, guards.requireAdmin] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const body = parseInput(createAgentRequestSchema, request.body, '创建 Agent 请求')
    reply.status(201).send(ctx.services.agents.create(body, user))
  })

  app.get('/api/agents/:id', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(idParams, request.params, '路径参数')
    const detail: AgentDetail = ctx.services.agents.get(id, user)
    reply.send(detail)
  })

  app.put('/api/agents/:id', { preHandler: [guards.authenticate, guards.requireAdmin] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(idParams, request.params, '路径参数')
    const body = parseInput(updateAgentRequestSchema, request.body, '更新 Agent 请求')
    reply.send(ctx.services.agents.update(id, body, user))
  })

  app.post(
    '/api/agents/:id/publish',
    { preHandler: [guards.authenticate, guards.requireAdmin] },
    async (request, reply) => {
      const { user } = requireAuth(request)
      const { id } = parseInput(idParams, request.params, '路径参数')
      const version: AgentVersionDto = await ctx.services.agents.publish(id, user)
      reply.send(version)
    },
  )

  app.post(
    '/api/agents/:id/disable',
    { preHandler: [guards.authenticate, guards.requireAdmin] },
    async (request, reply) => {
      const { user } = requireAuth(request)
      const { id } = parseInput(idParams, request.params, '路径参数')
      reply.send(ctx.services.agents.setEnabled(id, false, user))
    },
  )

  app.post(
    '/api/agents/:id/enable',
    { preHandler: [guards.authenticate, guards.requireAdmin] },
    async (request, reply) => {
      const { user } = requireAuth(request)
      const { id } = parseInput(idParams, request.params, '路径参数')
      reply.send(ctx.services.agents.setEnabled(id, true, user))
    },
  )

  app.get('/api/agents/:id/tools', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(idParams, request.params, '路径参数')
    reply.send(ctx.services.agents.tools(id, user))
  })

  app.post(
    '/api/agents/:id/sessions',
    { preHandler: [guards.authenticate] },
    async (request, reply) => {
      const { user } = requireAuth(request)
      const { id } = parseInput(idParams, request.params, '路径参数')
      const body = parseInput(createSessionSchema, request.body ?? {}, '创建会话请求') as CreateSessionRequest
      const session: SessionDto = ctx.services.sessions.create(id, user, body)
      reply.status(201).send(session)
    },
  )

  app.get('/api/catalog/tools', { preHandler: [guards.authenticate] }, async (_request, reply) => {
    const catalog = ctx.services.agents.catalog()
    const tools: ToolDescriptor[] = catalog.items
    // 契约：GET /api/catalog/tools -> { tools: ToolDescriptor[] }（docs/IMPL-GATEWAY.md §8）
    reply.send({ tools })
  })
}
