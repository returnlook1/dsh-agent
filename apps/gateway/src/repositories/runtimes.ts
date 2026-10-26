/** 运行时实例仓库：磁盘/进程生命周期的持久化投影（崩溃后用于清理）。 */
import type { RuntimeStatusDto } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import type { RuntimeRow } from '../db/types.js'

export type RuntimeState = RuntimeStatusDto['status']

export interface InsertRuntimeInput {
  id: string
  agentId: string
  agentVersion: number
  sessionId: string
  profile: string
  home: string
  workspace: string
  policyVersion: number
}

export class RuntimesRepository {
  constructor(private readonly db: GatewayDatabase) {}

  insert(input: InsertRuntimeInput): void {
    this.db
      .prepare(
        `INSERT INTO runtime_instances
           (id, agent_id, agent_version, session_id, profile, home, workspace, policy_version,
            pid, status, started_at, stopped_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'starting', ?, NULL, NULL)`,
      )
      .run(
        input.id,
        input.agentId,
        input.agentVersion,
        input.sessionId,
        input.profile,
        input.home,
        input.workspace,
        input.policyVersion,
        Date.now(),
      )
  }

  setPid(id: string, pid: number): void {
    this.db.prepare('UPDATE runtime_instances SET pid = ? WHERE id = ?').run(pid, id)
  }

  setStatus(id: string, status: RuntimeState, lastError?: string): void {
    const stoppedAt = status === 'stopped' || status === 'failed' ? Date.now() : null
    this.db
      .prepare('UPDATE runtime_instances SET status = ?, stopped_at = COALESCE(?, stopped_at), last_error = ? WHERE id = ?')
      .run(status, stoppedAt, lastError ?? null, id)
  }

  getById(id: string): RuntimeRow | undefined {
    return this.db.prepare('SELECT * FROM runtime_instances WHERE id = ?').get(id) as RuntimeRow | undefined
  }

  getActiveBySession(sessionId: string): RuntimeRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM runtime_instances
          WHERE session_id = ? AND status IN ('starting','ready','busy')
          ORDER BY started_at DESC LIMIT 1`,
      )
      .get(sessionId) as RuntimeRow | undefined
  }

  list(): RuntimeRow[] {
    return this.db
      .prepare('SELECT * FROM runtime_instances ORDER BY started_at DESC')
      .all() as unknown as RuntimeRow[]
  }

  listActive(): RuntimeRow[] {
    return this.db
      .prepare("SELECT * FROM runtime_instances WHERE status IN ('starting','ready','busy') ORDER BY started_at DESC")
      .all() as unknown as RuntimeRow[]
  }

  /** 崩溃修复：上一次进程留下的 running 记录一律置 stopped。 */
  markOrphansStopped(): RuntimeRow[] {
    const rows = this.listActive()
    if (rows.length === 0) return []
    this.db
      .prepare(
        `UPDATE runtime_instances
            SET status = 'stopped', stopped_at = ?, last_error = COALESCE(last_error, 'orphaned by gateway restart')
          WHERE status IN ('starting','ready','busy')`,
      )
      .run(Date.now())
    return rows
  }

  toDto(row: RuntimeRow): RuntimeStatusDto {
    const dto: RuntimeStatusDto = {
      runtimeId: row.id,
      agentId: row.agent_id,
      agentVersion: Number(row.agent_version),
      status: row.status as RuntimeState,
      policyVersion: Number(row.policy_version),
      startedAt: Number(row.started_at),
    }
    if (row.pid !== null) dto.pid = Number(row.pid)
    if (row.last_error !== null) dto.lastError = row.last_error
    return dto
  }
}
