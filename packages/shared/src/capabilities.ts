/**
 * 能力来源与在线管理（Skill / MCP）。
 *
 * 前端"能力来源"面板用这些类型：
 * - `GET /api/capabilities/sources`：技能根目录、MCP 配置文件、可执行动作；
 * - `POST /api/skills`：新建技能（写 `SKILL.md`）；
 * - `PUT/DELETE /api/mcp-servers/:id`：写回 `config/mcp-servers.json`；
 * - `POST /api/capabilities/reveal`：在资源管理器里打开目录/文件（仅本机）。
 */
import { z } from 'zod'
import type { McpServerDefinition, SkillSummaryDto } from './inventory.js'
import { mcpServerDefinitionSchema } from './inventory.js'

/** 一个技能根目录。 */
export interface CapabilitySkillRoot {
  path: string
  source: SkillSummaryDto['source']
  /** 展示名：项目技能目录 / DSH 用户技能 / 自定义目录。 */
  label: string
  /** 该根目录下的技能数量。 */
  count: number
  writable: boolean
}

export interface CapabilitySourcesResponse {
  skills: {
    roots: CapabilitySkillRoot[]
    total: number
    /** 新建技能会写到这里（第一个可写根目录）。 */
    writableRoot?: string
  }
  mcp: {
    configPath: string
    exists: boolean
    /** 本地配置文件里的条目数（不含 DSH Profile 导入）。 */
    localCount: number
    /** 从既有 DSH Profile 导入时的标识（只读）。 */
    dshSource?: string
  }
  /** 本地动作（打开目录、写文件）是否启用。 */
  actions: {
    enabled: boolean
    reveal: boolean
  }
}

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** `POST /api/skills` */
export const createSkillRequestSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(SKILL_NAME_PATTERN, '技能名字只允许小写字母、数字、点、下划线与连字符（1–64 字符）'),
  description: z.string().min(1).max(500),
  whenToUse: z.string().max(500).optional(),
  /** 正文（Markdown）；留空用模板。 */
  body: z.string().max(50_000).optional(),
})
export type CreateSkillRequest = z.infer<typeof createSkillRequestSchema>

export interface CreateSkillResponse {
  skill: SkillSummaryDto
}

/** `PUT /api/mcp-servers/:id`：id 由路径给出，body 不含 id。 */
export const upsertMcpServerRequestSchema = mcpServerDefinitionSchema.omit({ id: true })
export type UpsertMcpServerRequest = z.infer<typeof upsertMcpServerRequestSchema>

export interface UpsertMcpServerResponse {
  server: McpServerDefinition
}

/** `POST /api/capabilities/reveal` */
export const revealCapabilityRequestSchema = z.object({
  target: z.enum(['skills', 'mcp']),
})
export type RevealCapabilityRequest = z.infer<typeof revealCapabilityRequestSchema>

export interface RevealCapabilityResponse {
  opened: string
}

/** `GET /api/dsh-app`：唤起 DSH 桌面端（`dsh://open`）与网页端状态。 */
export interface DshAppResponse {
  /** 自定义协议深链（默认 `dsh://open`）。 */
  deepLink: string
  /** DSH 网页端地址（401 = 需要桌面端注入的凭据）。 */
  guiUrl: string
  guiReachable: boolean
  checkedAt: number
  /** 排障提示（打不开时展示）。 */
  hint?: string
}
