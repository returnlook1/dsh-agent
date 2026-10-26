/**
 * Gateway HTTP API 的传输对象（前端与网关共用）。
 */
import { z } from 'zod'
import {
  agentConfigSchema,
  agentStatusSchema,
  toolActionSchema,
  toolRiskSchema,
  type AgentConfig,
} from './agent-config.js'

/* ------------------------------------------------------------------ 用户与认证 */

export const roleSchema = z.enum(['admin', 'user'])
export type Role = z.infer<typeof roleSchema>

export interface UserDto {
  id: string
  username: string
  displayName: string
  role: Role
}

export interface LoginRequest {
  username: string
  password: string
}

export interface LoginResponse {
  token: string
  user: UserDto
  /** 过期时间（毫秒时间戳）。 */
  expiresAt: number
}

/* ------------------------------------------------------------------------ 工具 */

/** 工具来源：DSH 内置 / Agent Studio 业务工具 / MCP 服务器。 */
export const toolSourceSchema = z.enum(['dsh', 'business', 'mcp'])
export type ToolSource = z.infer<typeof toolSourceSchema>

export interface ToolDescriptor {
  name: string
  source: ToolSource
  /** MCP 工具所属的服务器 id。 */
  mcpServer?: string
  title: string
  description: string
  risk: z.infer<typeof toolRiskSchema>
  /** 该工具是否允许在受限 Agent 中被授予 ask（需要审批通道）。 */
  requiresApprovalChannel?: boolean
}

/** GET /api/agents/:id/tools 的响应：可用工具目录 + 当前授权。 */
export interface AgentToolsResponse {
  agentId: string
  version: number
  tools: Array<ToolDescriptor & { action: z.infer<typeof toolActionSchema> }>
  /** 目录里存在但被运行环境禁用的能力（例如 shell）。 */
  blockedCapabilities: string[]
}

/* ------------------------------------------------------------------- MCP 配置 */

export const mcpTransportSchema = z.enum(['stdio', 'sse', 'http'])
export type McpTransport = z.infer<typeof mcpTransportSchema>

export const mcpServerConfigSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-_]*$/),
  name: z.string().min(1).max(80),
  transport: mcpTransportSchema.default('stdio'),
  /** stdio: command + args；sse/http: url。 */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  url: z.string().url().optional(),
  /** 环境变量白名单（值从网关环境注入，不落库）。 */
  envKeys: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  /** 是否允许写操作（仅用于 UI 提示，真正限制在 MCP 工具授权）。 */
  readOnly: z.boolean().default(true),
})
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>

export interface McpServerDto extends McpServerConfig {
  createdAt: number
  updatedAt: number
  /** 最近一次健康检查结果。 */
  status?: 'unknown' | 'ok' | 'error'
  lastError?: string
}

/* ---------------------------------------------------------------------- Agent */

/** 列表页用的摘要。 */
export interface AgentSummary {
  id: string
  name: string
  description: string
  status: z.infer<typeof agentStatusSchema>
  version: number
  model: string
  provider: string
  /** 已授权（allow/ask）工具数量。 */
  toolCount: number
  updatedAt: number
}

export interface AgentVersionDto {
  agentId: string
  version: number
  createdAt: number
  createdBy: string
  /** 发布时的配置快照。 */
  config: AgentConfig
  /** 运行时是否成功验证过。 */
  verified: boolean
  /** 未能在运行时落实的配置项。 */
  warnings: ConfigWarning[]
}

export interface ConfigWarning {
  field: string
  message: string
}

export interface AgentDetail extends AgentSummary {
  /** 已发布版本（若无则 undefined）。 */
  publishedVersion?: number
  /** 当前编辑中的草稿配置。 */
  draft: AgentConfig
  versions: AgentVersionDto[]
  createdAt: number
  ownerId: string
}

/* -------------------------------------------------------------------- 会话 */

export const sessionStatusSchema = z.enum(['idle', 'running', 'failed', 'closed'])
export type SessionStatus = z.infer<typeof sessionStatusSchema>

export interface SessionDto {
  id: string
  userId: string
  agentId: string
  agentVersion: number
  dshSessionId?: string
  runtimeId?: string
  status: SessionStatus
  title: string
  createdAt: number
  updatedAt: number
  lastMessagePreview?: string
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ToolCallRecord {
  callId: string
  tool: string
  argumentsPreview?: string
  status: 'running' | 'succeeded' | 'failed' | 'denied'
  error?: string
  durationMs?: number
}

export interface MessageDto {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  sequence: number
  createdAt: number
  /** 该消息涉及的流式事件（工具调用等），用于历史回放。 */
  toolCalls?: ToolCallRecord[]
}

export interface CreateSessionRequest {
  title?: string
}

export interface SendMessageRequest {
  content: string
}

/* -------------------------------------------------------------------- 审批 */

export const approvalStatusSchema = z.enum(['pending', 'allowed', 'rejected', 'expired', 'cancelled'])
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>

export interface ApprovalDto {
  id: string
  sessionId: string
  approvalId: string
  tool: string
  description: string
  argumentsPreview: string
  status: ApprovalStatus
  createdAt: number
  expiresAt: number
  decidedAt?: number
  decidedBy?: string
}

export const approvalDecisionRequestSchema = z.object({
  decision: z.enum(['allowed-once', 'rejected', 'cancelled']),
  reason: z.string().max(400).optional(),
})
export type ApprovalDecisionRequest = z.infer<typeof approvalDecisionRequestSchema>

/* -------------------------------------------------------------------- 审计 */

export interface AuditQuery {
  sessionId?: string
  agentId?: string
  tool?: string
  decision?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export interface AuditPage {
  total: number
  items: Array<{
    id: string
    at: number
    sessionId: string
    agentId: string
    userId: string
    tool: string
    decision: string
    status: string
    argumentsPreview: string
    error?: string
    durationMs?: number
  }>
}

/* ---------------------------------------------------------------- 运行时状态 */

export interface RuntimeStatusDto {
  runtimeId: string
  agentId: string
  agentVersion: number
  status: 'starting' | 'ready' | 'busy' | 'stopped' | 'failed'
  pid?: number
  policyVersion: number
  startedAt: number
  lastError?: string
}

/** 健康检查。 */
export interface HealthResponse {
  ok: boolean
  version: string
  dshVersion: string
  database: 'ok' | 'error'
  runtimes: number
  uptimeSec: number
}

/* ------------------------------------------------------------------ 错误响应 */

export interface ApiError {
  error: {
    code: string
    message: string
    details?: unknown
  }
}

/** 统一的列表结果包装。 */
export interface ListResponse<T> {
  total: number
  items: T[]
}

/** 让前端可以直接用后端的校验器（可选）。 */
export const agentConfigForClient = agentConfigSchema
