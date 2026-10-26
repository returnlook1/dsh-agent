/** GET /api/health（公开）与 GET /api/runtimes（运行时排障视图）。 */
import type { FastifyInstance } from 'fastify'
import type { RuntimeInfo } from '@agent-studio/shared'
import type { AppContext } from '../context.js'

/** 服务版本（与 apps/gateway/package.json 对齐；不读文件，避免 dist 布局差异）。 */
export const SERVICE_VERSION = '2.0.0'

export interface HealthResponse {
  ok: boolean
  version: string
  dshVersion: string
  runtimes: number
  uptimeSec: number
}

export interface RuntimeListResponse {
  runtimes: RuntimeInfo[]
}

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async (): Promise<HealthResponse> => ({
    ok: true,
    version: SERVICE_VERSION,
    dshVersion: ctx.config.dshVersion,
    runtimes: ctx.pool.status().length,
    uptimeSec: Math.max(0, Math.floor((Date.now() - ctx.startedAt) / 1000)),
  }))

  app.get('/api/runtimes', async (): Promise<RuntimeListResponse> => ({
    runtimes: ctx.pool.status(),
  }))
}
