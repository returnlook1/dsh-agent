/** 会话服务：创建、归属校验、列表、消息/审批读取、停止运行时。 */
import { randomUUID } from 'node:crypto'
import type {
  ApprovalDto,
  CreateSessionRequest,
  MessageDto,
  SessionDto,
  UserDto,
} from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { AgentsRepository } from '../repositories/agents.js'
import type { ApprovalsRepository } from '../repositories/approvals.js'
import type { MessagesRepository } from '../repositories/messages.js'
import type { SessionsRepository } from '../repositories/sessions.js'
import { conflict, notFound } from '../http/errors.js'

export interface SessionRuntimePort {
  stopSession(sessionId: string, reason?: string): Promise<void>
}

export interface SessionServiceDeps {
  agents: AgentsRepository
  sessions: SessionsRepository
  messages: MessagesRepository
  approvals: ApprovalsRepository
  runtime: SessionRuntimePort
  logger: Logger
}

export class SessionService {
  constructor(private readonly deps: SessionServiceDeps) {}

  create(agentId: string, user: UserDto, input: CreateSessionRequest): SessionDto {
    const agent = this.deps.agents.getById(agentId)
    if (agent === undefined) throw notFound(`Agent 不存在: ${agentId}`)
    if (user.role !== 'admin' && agent.status !== 'published') throw notFound(`Agent 不存在: ${agentId}`)
    if (agent.currentVersion <= 0) throw conflict('Agent 尚未发布，无法创建会话')

    const row = this.deps.sessions.create({
      id: randomUUID(),
      userId: user.id,
      agentId,
      agentVersion: agent.currentVersion,
      title: input.title?.trim() ?? '',
    })
    return this.deps.sessions.toDto(row)
  }

  list(user: UserDto, agentId?: string): { total: number; items: SessionDto[] } {
    const rows = this.deps.sessions.listForUser(user.id, user.role, agentId)
    const items = rows.map((row) => this.deps.sessions.toDto(row, this.deps.sessions.lastMessagePreview(row.id)))
    return { total: items.length, items }
  }

  get(id: string, user: UserDto): SessionDto {
    const row = this.deps.sessions.getForUser(id, user.id, user.role)
    if (row === undefined) throw notFound(`会话不存在: ${id}`)
    return this.deps.sessions.toDto(row, this.deps.sessions.lastMessagePreview(id))
  }

  /** 归属校验 + 返回行（路由层后续操作使用）。 */
  requireOwned(id: string, user: UserDto) {
    const row = this.deps.sessions.getForUser(id, user.id, user.role)
    if (row === undefined) throw notFound(`会话不存在: ${id}`)
    return row
  }

  messages(id: string, user: UserDto): { total: number; items: MessageDto[] } {
    this.requireOwned(id, user)
    const items = this.deps.messages.listBySession(id).map((row) => this.deps.messages.toDto(row))
    return { total: items.length, items }
  }

  approvals(id: string, user: UserDto): { total: number; items: ApprovalDto[] } {
    this.requireOwned(id, user)
    const items = this.deps.approvals.listBySession(id).map((row) => this.deps.approvals.toDto(row))
    return { total: items.length, items }
  }

  async stop(id: string, user: UserDto): Promise<{ ok: true }> {
    this.requireOwned(id, user)
    await this.deps.runtime.stopSession(id, '用户停止生成')
    return { ok: true }
  }

  lastAssistantText(id: string): string {
    const row = this.deps.messages.getLastAssistant(id)
    return row?.content ?? ''
  }
}
