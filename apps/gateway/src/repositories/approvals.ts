/**
 * 审批仓库。
 *
 * 归属过滤通过 `agent_sessions.user_id` 完成：审批本身没有 user 列。
 * 过期一律是 `expired`（不是 allowed）：fail closed。
 */
import { randomUUID } from 'node:crypto'
import type { ApprovalDto, ApprovalStatus, Role } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import type { ApprovalRow } from '../db/types.js'

export interface InsertApprovalInput {
  sessionId: string
  approvalId: string
  tool: string
  description: string
  argumentsPreview: string
  argumentsDigest: string
  expiresAt: number
}

const DECISION_TO_STATUS: Record<'allowed-once' | 'rejected' | 'cancelled' | 'expired', ApprovalStatus> = {
  'allowed-once': 'allowed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  expired: 'expired',
}

export class ApprovalsRepository {
  constructor(private readonly db: GatewayDatabase) {}

  insert(input: InsertApprovalInput): ApprovalRow {
    const row: ApprovalRow = {
      id: randomUUID(),
      session_id: input.sessionId,
      approval_id: input.approvalId,
      tool: input.tool,
      description: input.description,
      arguments_preview: input.argumentsPreview,
      arguments_digest: input.argumentsDigest,
      status: 'pending',
      created_at: Date.now(),
      expires_at: input.expiresAt,
      decided_at: null,
      decided_by: null,
    }
    this.db
      .prepare(
        `INSERT INTO approvals
           (id, session_id, approval_id, tool, description, arguments_preview, arguments_digest,
            status, created_at, expires_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)`,
      )
      .run(
        row.id,
        row.session_id,
        row.approval_id,
        row.tool,
        row.description,
        row.arguments_preview,
        row.arguments_digest,
        row.created_at,
        row.expires_at,
      )
    return row
  }

  getById(id: string): ApprovalRow | undefined {
    return this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined
  }

  getByApprovalId(sessionId: string, approvalId: string): ApprovalRow | undefined {
    return this.db
      .prepare('SELECT * FROM approvals WHERE session_id = ? AND approval_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId, approvalId) as ApprovalRow | undefined
  }

  /** 归属过滤：审批 → 会话 → 用户。 */
  getForUser(id: string, userId: string, role: Role): ApprovalRow | undefined {
    if (role === 'admin') return this.getById(id)
    return this.db
      .prepare(
        `SELECT a.* FROM approvals a
           JOIN agent_sessions s ON s.id = a.session_id
          WHERE a.id = ? AND s.user_id = ?`,
      )
      .get(id, userId) as ApprovalRow | undefined
  }

  /**
   * 按"审批行 id **或** 插件侧 approvalId"解析，保持同样的归属过滤。
   *
   * 前端在 SSE 事件里拿到的是插件生成的 `approvalId`，管理端列表里同时有数据库行
   * id；两者都必须能用来提交决定，否则会把内部实现细节泄漏到 API 契约里。
   */
  resolveForUser(idOrApprovalId: string, userId: string, role: Role): ApprovalRow | undefined {
    const direct = this.getForUser(idOrApprovalId, userId, role)
    if (direct !== undefined) return direct
    if (role === 'admin') {
      return this.db
        .prepare('SELECT * FROM approvals WHERE approval_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(idOrApprovalId) as ApprovalRow | undefined
    }
    return this.db
      .prepare(
        `SELECT a.* FROM approvals a
           JOIN agent_sessions s ON s.id = a.session_id
          WHERE a.approval_id = ? AND s.user_id = ?
          ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(idOrApprovalId, userId) as ApprovalRow | undefined
  }

  listBySession(sessionId: string): ApprovalRow[] {
    return this.db
      .prepare('SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at DESC')
      .all(sessionId) as unknown as ApprovalRow[]
  }

  listPendingBySession(sessionId: string): ApprovalRow[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC")
      .all(sessionId) as unknown as ApprovalRow[]
  }

  updateDecision(
    id: string,
    decision: 'allowed-once' | 'rejected' | 'cancelled' | 'expired',
    decidedBy: string,
    decidedAt: number = Date.now(),
  ): ApprovalRow | undefined {
    this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?
          WHERE id = ? AND status = 'pending'`,
      )
      .run(DECISION_TO_STATUS[decision], decidedAt, decidedBy, id)
    return this.getById(id)
  }

  listExpiredPending(now: number): ApprovalRow[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?")
      .all(now) as unknown as ApprovalRow[]
  }

  /**
   * 启动修复：把遗留 pending 全部置 expired。
   * 返回受影响的审批，便于调用方尽力补写拒绝决定文件。
   */
  expireAllPending(now: number = Date.now()): ApprovalRow[] {
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status = 'pending'")
      .all() as unknown as ApprovalRow[]
    if (rows.length === 0) return []
    this.db
      .prepare("UPDATE approvals SET status = 'expired', decided_at = ?, decided_by = 'system' WHERE status = 'pending'")
      .run(now)
    return rows
  }

  toDto(row: ApprovalRow): ApprovalDto {
    const dto: ApprovalDto = {
      id: row.id,
      sessionId: row.session_id,
      approvalId: row.approval_id,
      tool: row.tool,
      description: row.description,
      argumentsPreview: row.arguments_preview,
      status: row.status,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
    }
    if (row.decided_at !== null) dto.decidedAt = Number(row.decided_at)
    if (row.decided_by !== null) dto.decidedBy = row.decided_by
    return dto
  }
}
