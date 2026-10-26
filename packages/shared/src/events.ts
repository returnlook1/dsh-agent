/**
 * Gateway → Web 的 SSE 事件协议。
 *
 * DSH 的原始通知绝不直接透传给前端：`DshEventAdapter` 负责把它映射成这里的
 * 稳定事件。协议版本升级时递增 EVENT_PROTOCOL_VERSION，前端可以据此降级。
 */
import { z } from 'zod'

export const EVENT_PROTOCOL_VERSION = 1

/** 一个工具调用在 UI 上的最小信息。 */
export interface ToolCallInfo {
  callId: string
  tool: string
  /** 参数摘要（已脱敏、已截断），用于审批弹窗和工具卡片。 */
  argumentsPreview?: string
  /** 由工具目录提供的风险等级。 */
  risk?: 'low' | 'medium' | 'high' | 'critical'
}

export interface AgentEventBase {
  sessionId: string
  /** 产生该事件的运行实例，便于排查。 */
  runtimeId?: string
  /** 事件时间（毫秒时间戳）。 */
  at: number
}

export interface MessageDeltaEvent extends AgentEventBase {
  type: 'message.delta'
  text: string
  /** 该增量属于哪条消息（网关落库用）。 */
  messageId?: string
  /** delta 为增量；message 表示一整条已提交的助手消息。 */
  mode: 'delta' | 'message'
}

export interface ToolStartedEvent extends AgentEventBase, ToolCallInfo {
  type: 'tool.started'
}

export interface ToolCompletedEvent extends AgentEventBase, ToolCallInfo {
  type: 'tool.completed'
  success: boolean
  /** 失败时的错误摘要。 */
  error?: string
  durationMs?: number
}

export interface ApprovalRequiredEvent extends AgentEventBase {
  type: 'approval.required'
  approvalId: string
  tool: string
  /** 面向用户的可读说明。 */
  description: string
  argumentsPreview?: string
  /** 过期时间（毫秒时间戳）；过期即拒绝。 */
  expiresAt: number
}

export interface ApprovalDecidedEvent extends AgentEventBase {
  type: 'approval.decided'
  approvalId: string
  decision: 'allowed-once' | 'rejected' | 'cancelled' | 'expired'
}

export interface AgentCompletedEvent extends AgentEventBase {
  type: 'agent.completed'
  text: string
  /** DSH 会话 id（首次运行后才有）。 */
  dshSessionId?: string
}

export interface AgentFailedEvent extends AgentEventBase {
  type: 'agent.failed'
  message: string
  code?: string
}

export interface RunStartedEvent extends AgentEventBase {
  type: 'run.started'
  runId: string
}

export interface TurnLimitEvent extends AgentEventBase {
  type: 'run.limit'
  reason: 'max-turns' | 'rate-limit' | 'max-concurrent'
  detail?: string
}

/** SSE 事件联合类型。 */
export type AgentEvent =
  | MessageDeltaEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ApprovalRequiredEvent
  | ApprovalDecidedEvent
  | AgentCompletedEvent
  | AgentFailedEvent
  | RunStartedEvent
  | TurnLimitEvent

export type AgentEventType = AgentEvent['type']

/** 带类型的事件名枚举，SSE 的 `event:` 行与之一一对应。 */
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'run.started',
  'message.delta',
  'tool.started',
  'tool.completed',
  'approval.required',
  'approval.decided',
  'agent.completed',
  'agent.failed',
  'run.limit',
]

/**
 * 把事件序列化成 SSE 帧。
 * @param event - 已适配的事件
 * @returns 完整的 `event:` / `data:` 帧文本
 */
export function toSseFrame(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/** 运行时侧（事件适配器）最小校验：只校验必有字段，避免过度约束。 */
export const agentEventSchema: z.ZodType<AgentEvent> = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run.started'),
    sessionId: z.string(),
    runId: z.string(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('message.delta'),
    sessionId: z.string(),
    text: z.string(),
    mode: z.enum(['delta', 'message']),
    messageId: z.string().optional(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool.started'),
    sessionId: z.string(),
    callId: z.string(),
    tool: z.string(),
    argumentsPreview: z.string().optional(),
    risk: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    sessionId: z.string(),
    callId: z.string(),
    tool: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    durationMs: z.number().optional(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval.required'),
    sessionId: z.string(),
    approvalId: z.string(),
    tool: z.string(),
    description: z.string(),
    argumentsPreview: z.string().optional(),
    expiresAt: z.number(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('approval.decided'),
    sessionId: z.string(),
    approvalId: z.string(),
    decision: z.enum(['allowed-once', 'rejected', 'cancelled', 'expired']),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('agent.completed'),
    sessionId: z.string(),
    text: z.string(),
    dshSessionId: z.string().optional(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('agent.failed'),
    sessionId: z.string(),
    message: z.string(),
    code: z.string().optional(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
  z.object({
    type: z.literal('run.limit'),
    sessionId: z.string(),
    reason: z.enum(['max-turns', 'rate-limit', 'max-concurrent']),
    detail: z.string().optional(),
    at: z.number(),
    runtimeId: z.string().optional(),
  }),
]) as z.ZodType<AgentEvent>
