/** GET /api/mcp-servers —— 可用 MCP 服务器清单（含配置文件路径，便于排障）。 */
import type { FastifyInstance } from 'fastify'
import type { McpServerListResponse } from '@agent-studio/shared'
import type { AppContext } from '../context.js'

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/mcp-servers', async (): Promise<McpServerListResponse> => ({
    servers: ctx.mcp.summaries(),
    configPath: ctx.mcp.configPath,
  }))
}
