/**
 * 模型清单接口：provider / model 全部来自 DSH 运行时，不在服务里写死。
 *
 * `GET /api/models`          —— 返回当前清单（内存/磁盘缓存命中时不重新探测）
 * `GET /api/models?refresh=1` —— 强制重新向 DSH 询问（例如换了 Provider 或 baseURL 之后）
 */
import type { FastifyInstance } from 'fastify'
import type { ModelCatalogResponse } from '@agent-studio/shared'
import type { AppContext } from '../context.js'

export function registerModelRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/models', async (request): Promise<ModelCatalogResponse> => {
    const query = request.query as { refresh?: string } | undefined
    const refresh = query?.refresh === '1' || query?.refresh === 'true'
    return await ctx.models.get({ refresh })
  })
}
