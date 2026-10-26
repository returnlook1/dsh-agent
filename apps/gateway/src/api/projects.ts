/** 项目级默认能力配置：GET 未保存时返回默认值 + `saved:false`；PUT body 为 patch。 */
import type { FastifyInstance } from 'fastify'
import { agentConfigPatchSchema, type ProjectAgentConfigDto } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { parseInput } from '../http/errors.js'

interface ProjectParams {
  projectId: string
}

export function registerProjectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/projects/:projectId/agent-config', async (request): Promise<ProjectAgentConfigDto> => {
    const { projectId } = request.params as ProjectParams
    return ctx.conversations.getProjectConfig(projectId)
  })

  app.put('/api/projects/:projectId/agent-config', async (request): Promise<ProjectAgentConfigDto> => {
    const { projectId } = request.params as ProjectParams
    const patch = parseInput(agentConfigPatchSchema, request.body ?? {}, '项目配置')
    return ctx.conversations.updateProjectConfig(projectId, patch)
  })
}
