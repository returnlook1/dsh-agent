/** 消息仓库：sequence 在会话内单调递增，用于 SSE 历史回放与分页。 */
import { randomUUID } from 'node:crypto'
import { messageRoleSchema, toolCallRecordSchema, type MessageDto, type ToolCallRecord } from '../schemas.js'
import type { GatewayDatabase } from '../db/database.js'
import { parseJsonColumn } from '../db/json.js'
import type { MessageRow } from '../db/types.js'
import type { Logger } from '../logger.js'

export interface AppendMessageInput {
  sessionId: string
  role: MessageDto['role']
  content: string
  toolCalls?: ToolCallRecord[]
}

export class MessagesRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly logger: Logger,
  ) {}

  append(input: AppendMessageInput): MessageRow {
    return this.db.transaction(() => {
      const nextRow = this.db
        .prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_messages WHERE session_id = ?')
        .get(input.sessionId) as { sequence: number }
      const row: MessageRow = {
        id: randomUUID(),
        session_id: input.sessionId,
        role: input.role,
        content: input.content,
        sequence: Number(nextRow.sequence),
        tool_calls_json: JSON.stringify(input.toolCalls ?? []),
        created_at: Date.now(),
      }
      this.db
        .prepare(
          `INSERT INTO agent_messages (id, session_id, role, content, sequence, tool_calls_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.id,
          row.session_id,
          row.role,
          row.content,
          row.sequence,
          row.tool_calls_json,
          row.created_at,
        )
      return row
    })
  }

  listBySession(sessionId: string): MessageRow[] {
    return this.db
      .prepare('SELECT * FROM agent_messages WHERE session_id = ? ORDER BY sequence ASC')
      .all(sessionId) as unknown as MessageRow[]
  }

  updateToolCalls(messageId: string, toolCalls: ToolCallRecord[]): void {
    this.db
      .prepare('UPDATE agent_messages SET tool_calls_json = ? WHERE id = ?')
      .run(JSON.stringify(toolCalls), messageId)
  }

  getLastAssistant(sessionId: string): MessageRow | undefined {
    return this.db
      .prepare("SELECT * FROM agent_messages WHERE session_id = ? AND role = 'assistant' ORDER BY sequence DESC LIMIT 1")
      .get(sessionId) as MessageRow | undefined
  }

  /** 限流：统计 (user, agent) 最近一小时的 user 消息数。 */
  countUserMessagesSince(userId: string, agentId: string, since: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM agent_messages m
           JOIN agent_sessions s ON s.id = m.session_id
          WHERE s.user_id = ? AND s.agent_id = ? AND m.role = 'user' AND m.created_at >= ?`,
      )
      .get(userId, agentId, since) as { count: number }
    return Number(row.count)
  }

  toDto(row: MessageRow): MessageDto {
    const dto: MessageDto = {
      id: row.id,
      sessionId: row.session_id,
      role: messageRoleSchema.parse(row.role),
      content: row.content,
      sequence: Number(row.sequence),
      createdAt: Number(row.created_at),
    }
    const toolCalls = parseJsonColumn(
      toolCallRecordSchema,
      row.tool_calls_json,
      'agent_messages.tool_calls_json',
      this.logger,
    )
    if (toolCalls.length > 0) dto.toolCalls = toolCalls
    return dto
  }
}
