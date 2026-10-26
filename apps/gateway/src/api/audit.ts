/** 审计查询（仅 admin）。 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { AppContext } from '../context.js'
import type { AuthGuards } from '../auth/guard.js'
import { parseInput } from '../http/errors.js'

const auditQuerySchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  agentId: z.string().min(1).max(64).optional(),
  tool: z.string().min(1).max(128).optional(),
  decision: z.string().min(1).max(32).optional(),
  from: z.coerce.number().int().nonnegative().optional(),
  to: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  app.get(
    '/api/audit/tool-calls',
    { preHandler: [guards.authenticate, guards.requireAdmin] },
    async (request, reply) => {
      const query = parseInput(auditQuerySchema, request.query ?? {}, '审计查询参数')
      reply.send(ctx.repos.audit.page(query))
    },
  )
}
