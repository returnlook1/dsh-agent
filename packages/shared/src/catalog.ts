/**
 * 工具目录契约。
 *
 * 业务工具由 `plugins/agent-tools` 实现并导出 `catalog.json`（构建产物的一部分），
 * 网关读取它来做"工具能力"页的展示与授权；DSH 内置工具与 MCP 工具由网关补充。
 * 目录只描述"存在什么工具"，不构成授权——授权永远来自策略快照。
 */
import { z } from 'zod'
import { toolRiskSchema } from './agent-config.js'

export const toolCatalogEntrySchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  source: z.enum(['dsh', 'business', 'mcp']).default('business'),
  risk: toolRiskSchema.default('low'),
  /** MCP 工具所属服务器。 */
  mcpServer: z.string().optional(),
  /** 参数 JSON Schema（供管理端渲染参数级授权提示）。 */
  parameters: z.record(z.string(), z.unknown()).optional(),
  /** 该工具是否需要人工审批通道；没有通道时必须 deny。 */
  requiresApprovalChannel: z.boolean().default(false),
  /** 第一版是否允许在受限 Agent 中启用。 */
  restrictedAllowed: z.boolean().default(true),
})
export type ToolCatalogEntry = z.infer<typeof toolCatalogEntrySchema>

export const toolCatalogSchema = z.object({
  catalogVersion: z.literal(1).default(1),
  generatedBy: z.string().default('agent-tools'),
  entries: z.array(toolCatalogEntrySchema),
})
export type ToolCatalog = z.infer<typeof toolCatalogSchema>

/** DSH 内置能力在受限环境中的处置说明，用于管理端提示。 */
export interface DshCapabilityPolicy {
  capability: string
  plugin: string
  restrictedDefault: 'removed' | 'denied'
  reason: string
}

/** 第一版受限运行时明确移除的能力清单（与 RESEARCH-PROFILE 对齐后由网关校验）。 */
export const RESTRICTED_BLOCKED_CAPABILITIES: readonly DshCapabilityPolicy[] = [
  {
    capability: 'shell',
    plugin: 'dsh-tool-pwsh / dsh-tool-bash',
    restrictedDefault: 'removed',
    reason: '受限 Agent 不提供任意命令执行，避免绕过工具权限与审计',
  },
  {
    capability: 'file-write',
    plugin: 'dsh-tool-fs',
    restrictedDefault: 'removed',
    reason: '文件写入需要独立 OS 沙箱，第一版不提供',
  },
  {
    capability: 'file-read',
    plugin: 'dsh-tool-fs',
    restrictedDefault: 'removed',
    reason: '业务数据只能通过已授权的业务工具读取',
  },
  {
    capability: 'web',
    plugin: 'dsh-tool-web',
    restrictedDefault: 'removed',
    reason: '出网能力仅通过白名单 MCP 服务器提供',
  },
  {
    capability: 'subagent',
    plugin: 'dsh-tool-subagent',
    restrictedDefault: 'removed',
    reason: '子智能体会扩大权限面，第一版禁用',
  },
  {
    capability: 'plugin-management',
    plugin: 'dsh-tool-cordis',
    restrictedDefault: 'removed',
    reason: '不允许 Agent 修改自身组合',
  },
  {
    capability: 'ptc',
    plugin: 'tools mode=ptc',
    restrictedDefault: 'removed',
    reason: '受限 Agent 固定使用 native 工具呈现模式',
  },
]
