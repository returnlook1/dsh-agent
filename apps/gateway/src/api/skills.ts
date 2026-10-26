/** GET /api/skills —— 可用技能清单（配置界面的数据源）。 */
import type { FastifyInstance } from 'fastify'
import type { SkillCatalogResponse } from '@agent-studio/shared'
import type { AppContext } from '../context.js'

export function registerSkillRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/skills', async (): Promise<SkillCatalogResponse> => ({
    skills: ctx.catalog.list(),
    roots: ctx.catalog.roots(),
  }))
}
