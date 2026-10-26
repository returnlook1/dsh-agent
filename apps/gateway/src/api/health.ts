/** 健康检查（公开，不泄露任何凭据或配置细节）。 */
import type { FastifyInstance } from 'fastify'
import type { HealthResponse } from '@agent-studio/shared'
import type { AppContext } from '../context.js'

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async (_request, reply) => {
    const databaseOk = ctx.db.ping()
    const response: HealthResponse = {
      ok: databaseOk,
      version: '1.0.0',
      dshVersion: ctx.config.dshVersion,
      database: databaseOk ? 'ok' : 'error',
      runtimes: ctx.runtime.status().length,
      uptimeSec: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
    }
    reply.status(databaseOk ? 200 : 503).send(response)
  })
}
