/**
 * 消息与历史。
 *
 * 消息记录是"展示用"的：真正的对话上下文在 DSH 的原生 session 里
 * （`$DSH_HOME/sessions/...`）。服务只额外保存一份便于前端回放的精简记录。
 */
import { z } from 'zod'

export type MessageRole = 'user' | 'assistant'

/** 工具调用的展示记录。 */
export interface ToolCallRecord {
  callId: string
  tool: string
  argumentsPreview?: string
  status: 'running' | 'succeeded' | 'failed'
  error?: string
  durationMs?: number
}

export interface MessageDto {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  /** 会话内单调递增，用于稳定排序。 */
  sequence: number
  createdAt: number
  /** 该条助手消息涉及的流式事件（工具调用等），用于历史回放。 */
  toolCalls?: ToolCallRecord[]
}

export interface MessageListResponse {
  conversationId: string
  messages: MessageDto[]
  /** 历史是否完整（运行时崩溃等情况可能截断）。 */
  truncated?: boolean
}

/** POST /api/conversations/:id/messages */
export const sendMessageRequestSchema = z.object({
  content: z.string().min(1).max(100_000),
})
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>

/** 统一错误响应。 */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    details?: unknown
  }
}
