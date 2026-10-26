/**
 * Agent Studio 业务配置模型。
 *
 * 注意：这个对象是 Agent Studio 自己的业务配置，**不是 DSH 原生配置格式**。
 * 其中每个字段都必须由运行时管理器 / 策略插件 / 网关分别落实，不能只保存 JSON
 * 就认为已经生效（见 docs/DECISIONS.md 的"配置落地矩阵"）。
 */
import { z } from 'zod'

/** 单个工具的执行策略。 */
export const toolActionSchema = z.enum(['allow', 'deny', 'ask'])
export type ToolAction = z.infer<typeof toolActionSchema>

/** 工具风险等级，仅用于前端展示与默认策略建议。 */
export const toolRiskSchema = z.enum(['low', 'medium', 'high', 'critical'])
export type ToolRisk = z.infer<typeof toolRiskSchema>

export const agentStatusSchema = z.enum(['draft', 'published', 'disabled'])
export type AgentStatus = z.infer<typeof agentStatusSchema>

export const networkAccessSchema = z.enum(['none', 'restricted', 'allowlist'])
export type NetworkAccess = z.infer<typeof networkAccessSchema>

/** 模型配置的默认值（同时用作 zod default 字面量与前端初始值）。 */
export const DEFAULT_MODEL_CONFIG = {
  provider: 'deepseek-official',
  modelId: 'deepseek-v4-flash',
} as const

export const modelConfigSchema = z.object({
  /** Provider id，必须与 DSH Provider 实际注册名一致。 */
  provider: z.string().min(1).default(DEFAULT_MODEL_CONFIG.provider),
  /** 模型 id，必须以 Provider 实际返回的名称为准。 */
  modelId: z.string().min(1).default(DEFAULT_MODEL_CONFIG.modelId),
  /** 采样温度。当前 DSH SDK 的 initialize 不携带该参数，落地方式见 DECISIONS §6。 */
  temperature: z.number().min(0).max(2).optional(),
  /** 单次根 Agent 请求的输出 token 上限；通过 SDK 的 maxTokens 落实。 */
  maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
  /** Provider 适配器支持的推理强度。 */
  reasoningEffort: z.string().optional(),
})
export type ModelConfig = z.infer<typeof modelConfigSchema>

export const promptConfigSchema = z.object({
  /** 系统提示词。通过受限 Profile 的 system prompt 插件注入，不放进用户消息。 */
  system: z.string().default(''),
  /** 聊天页的欢迎语，仅前端展示。 */
  welcome: z.string().default(''),
})
export type PromptConfig = z.infer<typeof promptConfigSchema>

export const capabilitiesSchema = z.object({
  /** 工具名 → 执行动作。工具清单由 Agent Studio 工具目录 + MCP 发现结果提供。 */
  tools: z.record(z.string(), toolActionSchema).default({}),
  /** 允许加载的 MCP 服务器 id 列表。 */
  mcpServers: z.array(z.string()).default([]),
  /** 允许加载的 Skills 名称。 */
  skills: z.array(z.string()).default([]),
  /** 是否允许派生子智能体。第一版默认关闭。 */
  subagents: z.boolean().default(false),
})
export type Capabilities = z.infer<typeof capabilitiesSchema>

export const securitySchema = z.object({
  /** 是否允许 Shell / 命令执行。 */
  shell: z.boolean().default(false),
  /** 是否允许读取文件系统。 */
  fileRead: z.boolean().default(false),
  /** 是否允许写入文件系统。 */
  fileWrite: z.boolean().default(false),
  /** 是否允许通过 Agent 管理 DSH 插件。 */
  pluginManagement: z.boolean().default(false),
  /** 出网策略。none 表示禁止，restricted 表示仅允许已配置的 MCP/业务接口。 */
  networkAccess: networkAccessSchema.default('restricted'),
  /** 数据范围描述（业务系统自己解释）。 */
  dataScope: z.string().default('user-authorized'),
})
export type Security = z.infer<typeof securitySchema>

export const limitsSchema = z.object({
  /** 单次用户请求内允许的 Agent 轮次（工具循环轮数）上限。 */
  maxTurns: z.number().int().min(1).max(200).default(20),
  /** 同一用户在同一 Agent 上允许的并发运行数。 */
  maxConcurrentRuns: z.number().int().min(1).max(8).default(1),
  /** 每用户每 Agent 每小时请求数上限。 */
  maxRequestsPerHour: z.number().int().min(1).max(10_000).default(30),
})
export type Limits = z.infer<typeof limitsSchema>

export const uiConfigSchema = z.object({
  showToolCalls: z.boolean().default(true),
  showReasoning: z.boolean().default(false),
  allowAttachments: z.boolean().default(false),
  showModelSelector: z.boolean().default(false),
})
export type UiConfig = z.infer<typeof uiConfigSchema>

/**
 * 完整 Agent 配置（入库、发布快照、运行时都使用这个形状）。
 * 所有嵌套对象都有完整默认值，因此 `agentConfigSchema.parse({ id, name })` 一定能得到可用配置。
 */
export const agentConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'id 只能包含小写字母、数字、- 和 _'),
  name: z.string().min(1).max(80),
  description: z.string().max(400).default(''),
  status: agentStatusSchema.default('draft'),
  version: z.number().int().min(1).default(1),
  model: modelConfigSchema.default({ ...DEFAULT_MODEL_CONFIG }),
  prompt: promptConfigSchema.default({ system: '', welcome: '' }),
  capabilities: capabilitiesSchema.default({
    tools: {},
    mcpServers: [],
    skills: [],
    subagents: false,
  }),
  security: securitySchema.default({
    shell: false,
    fileRead: false,
    fileWrite: false,
    pluginManagement: false,
    networkAccess: 'restricted',
    dataScope: 'user-authorized',
  }),
  limits: limitsSchema.default({
    maxTurns: 20,
    maxConcurrentRuns: 1,
    maxRequestsPerHour: 30,
  }),
  ui: uiConfigSchema.default({
    showToolCalls: true,
    showReasoning: false,
    allowAttachments: false,
    showModelSelector: false,
  }),
})
export type AgentConfig = z.infer<typeof agentConfigSchema>

/**
 * 写请求的输入形状：所有字段可选，由服务端与默认值合并。
 * 与 `agentConfigSchema` 分开定义的原因：`.partial()` 会把带 default 的字段变成
 * `T | undefined`，用于"部分更新"更清晰，也避免 zod 4 对 default 字面量的类型收紧问题。
 */
export const agentConfigInputSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(400).optional(),
  status: agentStatusSchema.optional(),
  version: z.number().int().min(1).optional(),
  model: modelConfigSchema.partial().optional(),
  prompt: promptConfigSchema.partial().optional(),
  capabilities: capabilitiesSchema.partial().optional(),
  security: securitySchema.partial().optional(),
  limits: limitsSchema.partial().optional(),
  ui: uiConfigSchema.partial().optional(),
})
export type AgentConfigInput = z.infer<typeof agentConfigInputSchema>

/** 创建 Agent：name 必填，id 可选（缺省由名称派生）。 */
export const createAgentRequestSchema = agentConfigInputSchema.extend({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'id 只能包含小写字母、数字、- 和 _')
    .optional(),
  name: z.string().min(1).max(80),
})
export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>

/** 更新 Agent（草稿或新版本）。 */
export const updateAgentRequestSchema = agentConfigInputSchema
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>

/**
 * 判断某条配置项在运行时是否真的能落实。
 * publish 时用它生成"未生效配置"警告，避免"只保存 JSON 就以为生效"。
 */
export interface ConfigEnforcement {
  field: string
  enforced: boolean
  mechanism: string
  note?: string
}

/** 由展示名派生稳定的 Agent id。 */
export function slugifyAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return slug || `agent-${Date.now().toString(36)}`
}

/**
 * 把写请求与已有配置合并成完整配置（服务端唯一入口）。
 * 嵌套对象浅合并即可：它们的字段都是标量或数组，调用方必须传完整数组。
 */
export function mergeAgentConfig(
  base: AgentConfig,
  patch: AgentConfigInput,
): AgentConfig {
  const merged = {
    ...base,
    ...patch,
    model: { ...base.model, ...(patch.model ?? {}) },
    prompt: { ...base.prompt, ...(patch.prompt ?? {}) },
    capabilities: { ...base.capabilities, ...(patch.capabilities ?? {}) },
    security: { ...base.security, ...(patch.security ?? {}) },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    ui: { ...base.ui, ...(patch.ui ?? {}) },
  }
  return agentConfigSchema.parse(merged)
}
