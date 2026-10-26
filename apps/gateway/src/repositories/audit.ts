/** 审计仓库：只追加，不修改；分页查询供管理端使用。 */
import type { AuditDecision, AuditPage, AuditRecord, AuditStatus } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import type { AuditRow } from '../db/types.js'

export interface AuditQueryInput {
  sessionId?: string
  agentId?: string
  tool?: string
  decision?: string
  from?: number
  to?: number
  limit: number
  offset: number
}

export class AuditRepository {
  constructor(private readonly db: GatewayDatabase) {}

  /** 幂等插入：同一 id 的重复 tail（重启后重读）不会产生重复行。 */
  insert(record: AuditRecord): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO agent_tool_audit
           (id, session_id, runtime_id, agent_id, agent_version, user_id, call_id, tool,
            decision, status, arguments_preview, arguments_digest, error, duration_ms, approval_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.sessionId,
        record.runtimeId,
        record.agentId,
        record.agentVersion,
        record.userId,
        record.callId,
        record.tool,
        record.decision,
        record.status,
        record.argumentsPreview,
        record.argumentsDigest,
        record.error ?? null,
        record.durationMs ?? null,
        record.approvalId ?? null,
        record.at,
      )
    return Number(result.changes) > 0
  }

  page(query: AuditQueryInput): AuditPage {
    const conditions: string[] = []
    const params: Array<string | number> = []
    if (query.sessionId !== undefined) {
      conditions.push('session_id = ?')
      params.push(query.sessionId)
    }
    if (query.agentId !== undefined) {
      conditions.push('agent_id = ?')
      params.push(query.agentId)
    }
    if (query.tool !== undefined) {
      conditions.push('tool = ?')
      params.push(query.tool)
    }
    if (query.decision !== undefined) {
      conditions.push('decision = ?')
      params.push(query.decision)
    }
    if (query.from !== undefined) {
      conditions.push('at >= ?')
      params.push(query.from)
    }
    if (query.to !== undefined) {
      conditions.push('at <= ?')
      params.push(query.to)
    }
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS count FROM agent_tool_audit ${where}`).get(...params) as {
      count: number
    }
    const rows = this.db
      .prepare(`SELECT * FROM agent_tool_audit ${where} ORDER BY at DESC LIMIT ? OFFSET ?`)
      .all(...params, query.limit, query.offset) as unknown as AuditRow[]

    return {
      total: Number(totalRow.count),
      items: rows.map((row) => {
        const item: AuditPage['items'][number] = {
          id: row.id,
          at: Number(row.at),
          sessionId: row.session_id,
          agentId: row.agent_id,
          userId: row.user_id,
          tool: row.tool,
          decision: row.decision as AuditDecision,
          status: row.status as AuditStatus,
          argumentsPreview: row.arguments_preview,
        }
        if (row.error !== null) item.error = row.error
        if (row.duration_ms !== null) item.durationMs = Number(row.duration_ms)
        return item
      }),
    }
  }
}
