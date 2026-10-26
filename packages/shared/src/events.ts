/**
 * SSE 事件协议（前端唯一需要理解的东西）。
 *
 * 设计原则：前端只依赖这 5 个业务事件，**不接触** DSH 的原始通知格式。
 * DSH 在 0.2.1-rc.3 上没有 token 级流式（每个 step 只有一条已提交消息），
 * 所以这里不提供 `message.delta`——`message.completed` 就是"一段助手文本完成"。
 */
import { z } from 'zod'

export const SERVICE_EVENT_VERSION = 1

export interface ServiceEventBase {
  conversationId: string
  /** 事件时间（毫秒时间戳）。 */
  at: number
}

/** 用户消息已被接受，开始处理。 */
export interface MessageStartedEvent extends ServiceEventBase {
  type: 'message.started'
  messageId: string
  role: 'user' | 'assistant'
}

/** 一段助手文本完成（每个 step 一条；没有 token 级增量）。 */
export interface MessageCompletedEvent extends ServiceEventBase {
  type: 'message.completed'
  messageId: string
  text: string
}

/** 模型请求了一次工具调用。 */
export interface ToolStartedEvent extends ServiceEventBase {
  type: 'tool.started'
  callId: string
  tool: string
  /** 参数摘要（已脱敏、已截断），供 UI 展示。 */
  argumentsPreview?: string
}

/** 工具调用结束。 */
export interface ToolCompletedEvent extends ServiceEventBase {
  type: 'tool.completed'
  callId: string
  tool: string
  success: boolean
  error?: string
  durationMs?: number
  /**
   * 结构化结果（能解析成 JSON 时）：例如 `map_fly_to` 返回
   * `{ action: "flyTo", longitude, latitude, zoom }`，前端可据此直接操作地图。
   * 只有成功且结果可解析时才出现；超过 4KB 的结果不内联（用 resultText 兜底）。
   */
  result?: unknown
  /** 结果的纯文本形式（截断到 4KB），无结构化结果时用于展示。 */
  resultText?: string
}

/** 本轮失败（模型错误、运行时不可用、超限等）。 */
export interface MessageFailedEvent extends ServiceEventBase {
  type: 'message.failed'
  message: string
  code?: string
}

export type ServiceEvent =
  | MessageStartedEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | MessageFailedEvent

export type ServiceEventType = ServiceEvent['type']

export const SERVICE_EVENT_TYPES: readonly ServiceEventType[] = [
  'message.started',
  'message.completed',
  'tool.started',
  'tool.completed',
  'message.failed',
]

/** 终止事件：出现后服务端结束本次 SSE 响应。 */
export const TERMINAL_EVENT_TYPES: readonly ServiceEventType[] = ['message.failed']

/** 序列化为 SSE 帧。 */
export function toSseFrame(event: ServiceEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** 运行时校验（服务端内部使用，避免发出畸形事件）。 */
export const serviceEventSchema: z.ZodType<ServiceEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message.started'),
    conversationId: z.string(),
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
    at: z.number(),
  }),
  z.object({
    type: z.literal('message.completed'),
    conversationId: z.string(),
    messageId: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('tool.started'),
    conversationId: z.string(),
    callId: z.string(),
    tool: z.string(),
    argumentsPreview: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    conversationId: z.string(),
    callId: z.string(),
    tool: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
    result: z.unknown().optional(),
    resultText: z.string().optional(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('message.failed'),
    conversationId: z.string(),
    message: z.string(),
    code: z.string().optional(),
    at: z.number(),
  }),
]) as z.ZodType<ServiceEvent>
