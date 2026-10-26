/**
 * 网关 API 封装。所有函数都只做「契约 → 类型」的映射，不含 UI 逻辑。
 */
import type {
  AgentDetail,
  AgentSummary,
  AgentToolsResponse,
  AgentVersionDto,
  ApprovalDecisionRequest,
  ApprovalDto,
  AuditPage,
  AuditQuery,
  CreateAgentRequest,
  CreateSessionRequest,
  HealthResponse,
  ListResponse,
  LoginRequest,
  LoginResponse,
  McpServerConfig,
  McpServerDto,
  MessageDto,
  SessionDto,
  UpdateAgentRequest,
  UserDto,
} from '@agent-studio/shared'

import { apiRequest } from './http'

/** MCP 连通性测试结果。 */
export interface McpTestResult {
  ok: boolean
  tools?: string[]
  error?: string
}

export const authApi = {
  login(payload: LoginRequest): Promise<LoginResponse> {
    return apiRequest<LoginResponse>('POST', '/auth/login', { body: payload })
  },
  me(): Promise<UserDto> {
    // 启动时的登录态复核要快速失败，避免网关无响应时白屏等待。
    return apiRequest<UserDto>('GET', '/auth/me', { timeoutMs: 6000 })
  },
}

export const agentApi = {
  list(): Promise<ListResponse<AgentSummary>> {
    return apiRequest<ListResponse<AgentSummary>>('GET', '/agents')
  },
  create(payload: CreateAgentRequest): Promise<AgentDetail> {
    return apiRequest<AgentDetail>('POST', '/agents', { body: payload })
  },
  get(id: string): Promise<AgentDetail> {
    return apiRequest<AgentDetail>('GET', `/agents/${encodeURIComponent(id)}`)
  },
  update(id: string, payload: UpdateAgentRequest): Promise<AgentDetail> {
    return apiRequest<AgentDetail>('PUT', `/agents/${encodeURIComponent(id)}`, { body: payload })
  },
  publish(id: string): Promise<AgentVersionDto> {
    return apiRequest<AgentVersionDto>('POST', `/agents/${encodeURIComponent(id)}/publish`)
  },
  disable(id: string): Promise<AgentDetail> {
    return apiRequest<AgentDetail>('POST', `/agents/${encodeURIComponent(id)}/disable`)
  },
  enable(id: string): Promise<AgentDetail> {
    return apiRequest<AgentDetail>('POST', `/agents/${encodeURIComponent(id)}/enable`)
  },
  tools(id: string): Promise<AgentToolsResponse> {
    return apiRequest<AgentToolsResponse>('GET', `/agents/${encodeURIComponent(id)}/tools`)
  },
}

export const mcpApi = {
  list(): Promise<ListResponse<McpServerDto>> {
    return apiRequest<ListResponse<McpServerDto>>('GET', '/mcp')
  },
  create(payload: McpServerConfig): Promise<McpServerDto> {
    return apiRequest<McpServerDto>('POST', '/mcp', { body: payload })
  },
  update(id: string, payload: McpServerConfig): Promise<McpServerDto> {
    return apiRequest<McpServerDto>('PUT', `/mcp/${encodeURIComponent(id)}`, { body: payload })
  },
  remove(id: string): Promise<void> {
    return apiRequest<void>('DELETE', `/mcp/${encodeURIComponent(id)}`)
  },
  test(id: string): Promise<McpTestResult> {
    return apiRequest<McpTestResult>('POST', `/mcp/${encodeURIComponent(id)}/test`)
  },
}

export const sessionApi = {
  create(agentId: string, payload: CreateSessionRequest = {}): Promise<SessionDto> {
    return apiRequest<SessionDto>('POST', `/agents/${encodeURIComponent(agentId)}/sessions`, {
      body: payload,
    })
  },
  list(agentId?: string): Promise<ListResponse<SessionDto>> {
    return apiRequest<ListResponse<SessionDto>>('GET', '/sessions', { query: { agentId } })
  },
  get(id: string): Promise<SessionDto> {
    return apiRequest<SessionDto>('GET', `/sessions/${encodeURIComponent(id)}`)
  },
  messages(id: string): Promise<ListResponse<MessageDto>> {
    return apiRequest<ListResponse<MessageDto>>('GET', `/sessions/${encodeURIComponent(id)}/messages`)
  },
  stop(id: string): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>('POST', `/sessions/${encodeURIComponent(id)}/stop`)
  },
}

export const approvalApi = {
  decide(approvalId: string, payload: ApprovalDecisionRequest): Promise<ApprovalDto> {
    return apiRequest<ApprovalDto>('POST', `/approvals/${encodeURIComponent(approvalId)}/decision`, {
      body: payload,
    })
  },
}

export const auditApi = {
  query(query: AuditQuery): Promise<AuditPage> {
    return apiRequest<AuditPage>('GET', '/audit/tool-calls', {
      query: {
        sessionId: query.sessionId,
        agentId: query.agentId,
        tool: query.tool,
        decision: query.decision,
        from: query.from,
        to: query.to,
        limit: query.limit,
        offset: query.offset,
      },
    })
  },
}

export const systemApi = {
  health(): Promise<HealthResponse> {
    return apiRequest<HealthResponse>('GET', '/health', { timeoutMs: 6000 })
  },
}
