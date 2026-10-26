/**
 * 能力配置：一个对话用哪些 Skills、哪些 MCP 服务器、哪个模型。
 *
 * 两级继承：
 * - **项目级**：项目默认能力，项目下的对话默认继承；
 * - **对话级**：创建对话时可覆盖/扩展。
 *
 * 服务只保存"启用哪些能力的引用"；Skills 与 MCP 的定义仍由 DSH 侧
 * （skills 目录、MCP 服务器配置）管理，这里不保存插件实现。
 */
import { z } from 'zod'

/** 默认模型路由（必须在 DSH Provider 中真实存在）。 */
export const DEFAULT_PROVIDER = 'deepseek-official'
export const DEFAULT_MODEL = 'deepseek-flash'

/**
 * 可配置能力（项目级与对话级共用同一形状）。
 *
 * `systemPrompt` 随运行时快照固定下来：它属于服务端配置，不是用户消息，
 * 前端无法在单轮里覆盖。
 */
export const agentConfigSchema = z.object({
  /** 启用的 Skills 名称（引用技能目录里的定义）。 */
  skills: z.array(z.string().min(1)).default([]),
  /** 启用的 MCP 服务器 id（引用服务侧 `config/mcp-servers.json` 的定义）。 */
  mcpServers: z.array(z.string().min(1)).default([]),
  /** Provider id，必须与 DSH 实际注册名一致。 */
  provider: z.string().min(1).default(DEFAULT_PROVIDER),
  /** 模型 id，必须以 Provider 实际返回的名称为准。 */
  model: z.string().min(1).default(DEFAULT_MODEL),
  /** 服务端系统提示词；为空时使用运行时默认提示词。 */
  systemPrompt: z.string().max(20_000).default(''),
})
export type AgentConfig = z.infer<typeof agentConfigSchema>

/** 部分更新：PUT 时未提供的字段保持原值。 */
export const agentConfigPatchSchema = z.object({
  skills: z.array(z.string().min(1)).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().max(20_000).optional(),
})
export type AgentConfigPatch = z.infer<typeof agentConfigPatchSchema>

/** 项目级默认配置 + 元数据。 */
export interface ProjectAgentConfigDto extends AgentConfig {
  projectId: string
  /** 从未保存过时返回默认值，`saved` 为 false。 */
  saved: boolean
  updatedAt?: number
}

/** 对话里冻结下来的配置快照（创建后不再改变）。 */
export interface AgentConfigSnapshot extends AgentConfig {
  /** 配置指纹：相同的指纹复用同一个 DSH 运行时。 */
  configKey: string
  /** 该快照继承自哪个项目。 */
  projectId: string
  /** 创建快照的时间。 */
  createdAt: number
  /** 创建对话时是否继承了项目配置（便于排查）。 */
  inheritedFromProject: boolean
}

/**
 * 合并项目配置与对话覆盖。
 *
 * 合并规则（有意为之，写进文档避免歧义）：
 * - `skills` / `mcpServers`：**并集**（"覆盖或扩展"里的"扩展"）；
 * - `provider` / `model` / `systemPrompt`：对话值优先，缺省用项目值，再缺省用默认值；
 * - `inheritProjectConfig = false` 时完全不看项目配置。
 */
export function mergeAgentConfig(
  project: AgentConfig | undefined,
  override: AgentConfigPatch | undefined,
  inheritProjectConfig: boolean,
): AgentConfig {
  if (!inheritProjectConfig) {
    return agentConfigSchema.parse({ ...(override ?? {}) })
  }
  const base = agentConfigSchema.parse({ ...(project ?? {}) })
  if (override === undefined) return base
  return agentConfigSchema.parse({
    ...base,
    provider: override.provider ?? base.provider,
    model: override.model ?? base.model,
    systemPrompt: override.systemPrompt ?? base.systemPrompt,
    skills: unique([...base.skills, ...(override.skills ?? [])]),
    mcpServers: unique([...base.mcpServers, ...(override.mcpServers ?? [])]),
  })
}

/** 稳定去重（保留首次出现顺序）。 */
export function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
