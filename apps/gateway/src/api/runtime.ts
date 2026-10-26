/** 运行时状态（仅 admin）。 */
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context.js'
import type { AuthGuards } from '../auth/guard.js'

export function registerRuntimeRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  app.get(
    '/api/runtime/status',
    { preHandler: [guards.authenticate, guards.requireAdmin] },
    async (_request, reply) => {
      const items = ctx.runtime.status()
      reply.send({ total: items.length, items })
    },
  )
}
