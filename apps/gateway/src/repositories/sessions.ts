/**
 * 会话仓库。
 *
 * 归属过滤是本文件的安全核心：所有面向用户的读取都必须带 `user_id = ?`，
 * 只有 admin 可以省略（docs/DECISIONS.md §9.3）。
 */
import type { Role, SessionDto, SessionStatus } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import type { SessionRow } from '../db/types.js'

export interface CreateSessionInput {
  id: string
  userId: string
  agentId: string
  agentVersion: number
  title: string
}

export class SessionsRepository {
  constructor(private readonly db: GatewayDatabase) {}

  create(input: CreateSessionInput): SessionRow {
    const now = Date.now()
    const row: SessionRow = {
      id: input.id,
      user_id: input.userId,
      agent_id: input.agentId,
      agent_version: input.agentVersion,
      dsh_session_id: null,
      runtime_id: null,
      status: 'idle',
      title: input.title,
      created_at: now,
      updated_at: now,
    }
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (id, user_id, agent_id, agent_version, dsh_session_id, runtime_id, status, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, 'idle', ?, ?, ?)`,
      )
      .run(row.id, row.user_id, row.agent_id, row.agent_version, row.title, row.created_at, row.updated_at)
    return row
  }

  getById(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id) as SessionRow | undefined
  }

  /** 非 admin 必须命中 `user_id`，否则视为不存在（避免枚举他人会话）。 */
  getForUser(id: string, userId: string, role: Role): SessionRow | undefined {
    if (role === 'admin') return this.getById(id)
    return this.db
      .prepare('SELECT * FROM agent_sessions WHERE id = ? AND user_id = ?')
      .get(id, userId) as SessionRow | undefined
  }

  listForUser(userId: string, role: Role, agentId?: string): SessionRow[] {
    if (role === 'admin') {
      return (
        agentId === undefined
          ? this.db.prepare('SELECT * FROM agent_sessions ORDER BY updated_at DESC').all()
          : this.db
              .prepare('SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY updated_at DESC')
              .all(agentId)
      ) as unknown as SessionRow[]
    }
    return (
      agentId === undefined
        ? this.db
            .prepare('SELECT * FROM agent_sessions WHERE user_id = ? ORDER BY updated_at DESC')
            .all(userId)
        : this.db
            .prepare('SELECT * FROM agent_sessions WHERE user_id = ? AND agent_id = ? ORDER BY updated_at DESC')
            .all(userId, agentId)
    ) as unknown as SessionRow[]
  }

  updateStatus(id: string, status: SessionStatus): void {
    this.db
      .prepare('UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, Date.now(), id)
  }

  setRuntime(id: string, runtimeId: string, dshSessionId: string): void {
    this.db
      .prepare(
        'UPDATE agent_sessions SET runtime_id = ?, dsh_session_id = COALESCE(?, dsh_session_id), updated_at = ? WHERE id = ?',
      )
      .run(runtimeId, dshSessionId, Date.now(), id)
  }

  clearRuntime(id: string): void {
    this.db
      .prepare('UPDATE agent_sessions SET runtime_id = NULL, updated_at = ? WHERE id = ?')
      .run(Date.now(), id)
  }

  updateTitle(id: string, title: string): void {
    this.db.prepare('UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?').run(title, Date.now(), id)
  }

  touch(id: string): void {
    this.db.prepare('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  countRunning(userId: string, agentId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_sessions WHERE user_id = ? AND agent_id = ? AND status = 'running'")
      .get(userId, agentId) as { count: number }
    return Number(row.count)
  }

  /** 启动修复：没有运行实例的 running 会话回到 idle。 */
  repairRunningSessions(): number {
    const result = this.db
      .prepare("UPDATE agent_sessions SET status = 'idle', updated_at = ? WHERE status = 'running'")
      .run(Date.now())
    return Number(result.changes)
  }

  lastMessagePreview(sessionId: string): string | undefined {
    const row = this.db
      .prepare(
        `SELECT content FROM agent_messages WHERE session_id = ? ORDER BY sequence DESC LIMIT 1`,
      )
      .get(sessionId) as { content: string } | undefined
    if (row === undefined) return undefined
    const text = row.content.replace(/\s+/g, ' ').trim()
    if (text === '') return undefined
    return text.length > 120 ? `${text.slice(0, 120)}…` : text
  }

  toDto(row: SessionRow, preview?: string): SessionDto {
    const dto: SessionDto = {
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      agentVersion: Number(row.agent_version),
      status: row.status,
      title: row.title,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
    if (row.dsh_session_id !== null) dto.dshSessionId = row.dsh_session_id
    if (row.runtime_id !== null) dto.runtimeId = row.runtime_id
    if (preview !== undefined) dto.lastMessagePreview = preview
    return dto
  }
}
