/**
 * 能力来源与本地动作（Skill / MCP）+ DSH 唤起。
 *
 * - `GET    /api/capabilities/sources`  技能根目录 / MCP 配置 / 可执行动作
 * - `POST   /api/capabilities/reveal`   在资源管理器打开目录或配置文件（仅本机）
 * - `POST   /api/skills`                新建技能（写 SKILL.md）
 * - `DELETE /api/skills/:name`          删除可写目录下的技能
 * - `PUT    /api/mcp-servers/:id`       新增/修改 MCP 定义（写 config/mcp-servers.json）
 * - `DELETE /api/mcp-servers/:id`       删除本地定义
 * - `GET    /api/dsh-app`               唤起 DSH 桌面端的深链 + 网页端可达性
 */
import type { FastifyInstance } from 'fastify'
import {
  createSkillRequestSchema,
  revealCapabilityRequestSchema,
  upsertMcpServerRequestSchema,
  type CreateSkillResponse,
  type DshAppResponse,
  type RevealCapabilityResponse,
  type UpsertMcpServerResponse,
} from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { parseInput, validationError } from '../http/errors.js'

interface McpParams {
  id: string
}

/** 网页端可达性缓存：避免每次点开都探测。 */
const GUI_PROBE_TTL_MS = 5_000
let guiProbe: { at: number; reachable: boolean } | undefined

async function probeGui(url: string): Promise<boolean> {
  const now = Date.now()
  if (guiProbe !== undefined && now - guiProbe.at < GUI_PROBE_TTL_MS) return guiProbe.reachable
  let reachable = false
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500), redirect: 'manual' })
    // 401/403 说明端口活着（桌面端注入凭据），同样算可达。
    reachable = response.status > 0
    await response.body?.cancel().catch(() => undefined)
  } catch {
    reachable = false
  }
  guiProbe = { at: now, reachable }
  return reachable
}

export function registerCapabilityRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/capabilities/sources', async () => ctx.capabilities.sources())

  app.post('/api/capabilities/reveal', async (request): Promise<RevealCapabilityResponse> => {
    const input = parseInput(revealCapabilityRequestSchema, request.body ?? {}, '打开目录请求')
    return ctx.capabilities.reveal(input.target)
  })

  app.post('/api/skills', async (request, reply): Promise<CreateSkillResponse> => {
    const input = parseInput(createSkillRequestSchema, request.body ?? {}, '新建技能请求')
    const skill = ctx.capabilities.createSkill(input)
    reply.status(201)
    // 新建后清单立即变化，重新加载模型清单没必要，这里只返回技能本身。
    return { skill }
  })

  app.delete('/api/skills/:name', async (request, reply) => {
    const { name } = request.params as { name: string }
    if (name.trim().length === 0) throw validationError('技能名不能为空')
    ctx.capabilities.deleteSkill(name)
    reply.status(204).send()
  })

  app.put('/api/mcp-servers/:id', async (request): Promise<UpsertMcpServerResponse> => {
    const { id } = request.params as McpParams
    const body = parseInput(upsertMcpServerRequestSchema, request.body ?? {}, 'MCP 定义')
    const server = ctx.capabilities.upsertMcpServer({ ...body, id })
    return { server }
  })

  app.delete('/api/mcp-servers/:id', async (request, reply) => {
    const { id } = request.params as McpParams
    ctx.capabilities.deleteMcpServer(id)
    reply.status(204).send()
  })

  app.get('/api/dsh-app', async (): Promise<DshAppResponse> => {
    const guiUrl = ctx.config.dshGuiUrl.trim()
    // 桌面端每次启动的端口可能变化，因此默认不探测；显式设置 DSH_GUI_URL 才给可达性。
    const reachable = guiUrl.length > 0 ? await probeGui(guiUrl) : false
    return {
      deepLink: ctx.config.dshDeepLink,
      guiUrl,
      guiReachable: reachable,
      checkedAt: Date.now(),
      hint:
        guiUrl.length === 0
          ? '点「打开 DSH」会通过 dsh:// 唤起桌面端；模型、Provider、凭据都在 DSH 里配置。'
          : reachable
            ? '点「打开 DSH」会唤起桌面端；模型、Provider、凭据都在 DSH 里配置。'
            : `未检测到 ${guiUrl}。请从开始菜单启动 DeepSeek Harness，或检查 DSH_GUI_URL。`,
    }
  })
}
