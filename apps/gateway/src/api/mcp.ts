/**
 * MCP 能力接口（docs/SERVICE.md §7）：
 *
 * - `GET  /api/mcp-servers`                 可用服务器清单（含来源）
 * - `POST /api/mcp-servers/:id/test`        连接测试（握手 + 列工具）
 * - `GET  /api/mcp-servers/:id/tools`       工具清单（同样走一次探测）
 * - `GET  /api/dsh-source`                  既有 DSH 配置来源的诊断信息
 *
 * 探测可能耗时（stdio 起进程、http 建连接），默认超时 20s。
 * 凭据只在子进程/请求头里出现，响应与日志只有名字与错误信息。
 */
import type { FastifyInstance } from 'fastify'
import { mcpProbeRequestSchema, type McpProbeResponse, type McpServerListResponse } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { notFound, parseInput } from '../http/errors.js'
import { probeMcpServer } from '../mcp/McpProbe.js'

interface McpParams {
  id: string
}

const DEFAULT_PROBE_TIMEOUT_MS = 20_000

export function registerMcpRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/mcp-servers', async (): Promise<McpServerListResponse> => {
    const label = ctx.dshSource.label()
    return {
      servers: ctx.mcp.summaries(),
      configPath: ctx.mcp.configPath,
      ...(label === undefined ? {} : { dshSource: label }),
    }
  })

  const probe = async (serverId: string, timeoutMs?: number): Promise<McpProbeResponse> => {
    const definition = ctx.mcp.get(serverId)
    if (definition === undefined) throw notFound(`MCP 服务器不存在或未启用: ${serverId}`)
    const target = ctx.mcp.probeTarget(definition, timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    return await probeMcpServer(target, ctx.logger.child({ component: 'mcp-probe', serverId }))
  }

  app.post('/api/mcp-servers/:id/test', async (request): Promise<McpProbeResponse> => {
    const { id } = request.params as McpParams
    const body = parseInput(mcpProbeRequestSchema, request.body ?? {}, 'MCP 探测请求')
    return await probe(id, body.timeoutMs)
  })

  app.get('/api/mcp-servers/:id/tools', async (request): Promise<McpProbeResponse> => {
    const { id } = request.params as McpParams
    return await probe(id)
  })

  app.get('/api/dsh-source', async () => ctx.dshSource.describe())
}
