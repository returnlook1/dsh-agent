/**
 * 服务侧能力清单：可用 Skills 与可用 MCP 服务器。
 *
 * 这两个接口给"配置界面"用：先列出存在什么能力，再选择启用哪些。
 * 服务只做目录（discovery），不实现这些能力本身。
 */
import { z } from 'zod'

/** Skills 目录里的一项。 */
export interface SkillSummaryDto {
  name: string
  description: string
  /** 何时使用（来自 frontmatter 的可选字段）。 */
  whenToUse?: string
  /** 定义来源：项目技能目录 / 自定义目录 / 用户目录。 */
  source: 'project' | 'custom' | 'user' | 'bundled'
  /** 定义所在文件（排障用）。 */
  path?: string
}

/** GET /api/skills */
export interface SkillCatalogResponse {
  skills: SkillSummaryDto[]
  /** 扫描过的根目录，便于排查"为什么看不到我的技能"。 */
  roots: Array<{ path: string; source: SkillSummaryDto['source'] }>
}

/* --------------------------------------------------------------------- MCP */

export const mcpTransportSchema = z.enum(['stdio', 'streamable-http'])
export type McpTransport = z.infer<typeof mcpTransportSchema>

/**
 * MCP 服务器定义（配置文件 `config/mcp-servers.json`）。
 *
 * 定义本身不在代码里重复实现：服务只负责把选中的条目翻译成 DSH 的
 * `dsh-mcp-client` 插件配置。
 */
export const mcpServerDefinitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, 'MCP 服务器 id 只允许字母、数字、- 和 _，最长 32 字符'),
  name: z.string().min(1).max(120),
  description: z.string().max(400).optional(),
  transport: mcpTransportSchema.default('stdio'),
  /** stdio：可执行文件。 */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  /** stdio：额外环境变量（值支持 `${ENV_NAME}` 占位，从服务进程环境读取，不落盘）。 */
  env: z.record(z.string(), z.string()).default({}),
  /** streamable-http：MCP 端点。 */
  url: z.string().url().optional(),
  /** streamable-http：附加请求头（同样支持 `${ENV_NAME}` 占位）。 */
  headers: z.record(z.string(), z.string()).default({}),
  /** 单次工具调用超时。 */
  toolCallTimeoutMs: z.number().int().min(1_000).max(600_000).default(30_000),
  /** 初始连接失败是否让运行时启动失败（默认 false：只影响该服务器）。 */
  failOnStartup: z.boolean().default(false),
  enabled: z.boolean().default(true),
})
export type McpServerDefinition = z.infer<typeof mcpServerDefinitionSchema>

/** 定义来源：本地配置文件 / 从既有 DSH Profile 导入。 */
export type McpServerSource = 'config' | 'dsh-profile'

/** GET /api/mcp-servers 的列表项。 */
export interface McpServerSummaryDto {
  id: string
  name: string
  description?: string
  transport: McpTransport
  enabled: boolean
  /** 定义来自哪里（排障与 UI 提示用）。 */
  source: McpServerSource
}

export interface McpServerListResponse {
  servers: McpServerSummaryDto[]
  /** 配置文件路径，排障用。 */
  configPath: string
  /** 从既有 DSH Profile 导入时，该 profile 的标识（`home#profile`）。 */
  dshSource?: string
}

/* --------------------------------------------------------------- MCP 探测 */

/** 一个 MCP 工具（`tools/list` 的结果项）。 */
export interface McpToolInfo {
  name: string
  description?: string
  /** 工具入参的 JSON Schema（原样透传，前端可渲染成表单）。 */
  inputSchema?: unknown
}

/** `POST /api/mcp-servers/:id/test` 与 `GET /api/mcp-servers/:id/tools` 的响应。 */
export interface McpProbeResponse {
  ok: boolean
  serverId: string
  serverName?: string
  /** MCP 协议版本（握手结果）。 */
  protocolVersion?: string
  tools: McpToolInfo[]
  /** 连接 + 列表耗时。 */
  durationMs: number
  /** 失败原因（ok=false 时）。 */
  error?: string
  /** 探测方式：stdio 子进程 / streamable-http。 */
  transport: McpTransport
}

export const mcpProbeRequestSchema = z.object({
  /** 覆盖定义里的超时（毫秒），默认取定义值。 */
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
})
export type McpProbeRequest = z.infer<typeof mcpProbeRequestSchema>
