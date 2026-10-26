/**
 * 对话（conversation）契约。
 *
 * 业务侧只认 `conversationId`；`sessionId` 是它在 DSH 运行时里的会话标识，
 * 由服务创建并保存，前端一般不需要直接使用。
 */
import { z } from 'zod'
import type { AgentConfigPatch, AgentConfigSnapshot } from './agent-config.js'

/** 对话运行状态。 */
export const conversationStatusSchema = z.enum(['idle', 'running', 'failed'])
export type ConversationStatus = z.infer<typeof conversationStatusSchema>

export interface ConversationDto {
  /** 业务对话 id（服务生成）。 */
  id: string
  /** 归属项目：能力配置按项目继承。 */
  projectId: string
  /** DSH 运行时里的会话 id（用于恢复历史）。 */
  sessionId: string
  /** 该对话冻结的能力配置快照。 */
  config: AgentConfigSnapshot
  status: ConversationStatus
  /** 展示用标题，缺省取首条用户消息。 */
  title: string
  createdAt: number
  updatedAt: number
  /** 已记录的消息条数。 */
  messageCount: number
  /** 最近一次失败原因（status=failed 时）。 */
  lastError?: string
}

/** 创建对话。 */
export const createConversationRequestSchema = z.object({
  projectId: z.string().min(1).max(120),
  /** 对话级能力覆盖；与项目配置取并集。 */
  skills: z.array(z.string().min(1)).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
  /** 可选：从 DSH 的模型清单里挑一个（不填则用 DSH 默认路由）。 */
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  /** 是否继承项目配置，默认 true。 */
  inheritProjectConfig: z.boolean().optional(),
  /** 展示用标题；缺省由首条消息生成。 */
  title: z.string().max(200).optional(),
})
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>

export interface CreateConversationResponse {
  conversationId: string
  sessionId: string
  config: AgentConfigSnapshot
}

/** 修改对话的能力配置。 */
export const updateConversationConfigRequestSchema = z.object({
  skills: z.array(z.string().min(1)).optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  systemPrompt: z.string().max(20_000).optional(),
}) satisfies z.ZodType<AgentConfigPatch>
export type UpdateConversationConfigRequest = z.infer<typeof updateConversationConfigRequestSchema>

/** `PATCH /api/conversations/:id`：只允许改标题。 */
export const updateConversationRequestSchema = z.object({
  title: z.string().min(1).max(200),
})
export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>

/**
 * `POST /api/conversations/:id/stop` 的响应。
 *
 * 注意：SDK 没有"取消单轮"的接口，停止 = 关闭承载该对话的运行时；
 * 如果同一运行时上还有别的对话在跑，服务会拒绝（`RUNTIME_BUSY`），
 * 避免误伤其它对话。
 */
export interface StopConversationResponse {
  ok: boolean
  /** 是否真的关闭了运行时。 */
  runtimeClosed: boolean
  /** 附加说明（例如"运行时上还有其它对话在运行"）。 */
  note?: string
}

/** 列表项（history）。 */
export interface ConversationSummary {
  id: string
  projectId: string
  title: string
  status: ConversationStatus
  createdAt: number
  updatedAt: number
  messageCount: number
}

/**
 * 运行时实例的只读视图（排障用，不对外承诺稳定）。
 * 相同 `configKey` 的对话共享同一个运行时。
 */
export interface RuntimeInfo {
  runtimeId: string
  configKey: string
  provider: string
  model: string
  skills: string[]
  mcpServers: string[]
  /** 该运行时上挂着的对话数。 */
  conversationCount: number
  /** 正在执行中的对话数。 */
  runningCount: number
  pid?: number
  startedAt: number
  lastActiveAt: number
}
