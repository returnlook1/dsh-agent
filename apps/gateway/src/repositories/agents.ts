/**
 * Agent 仓库。
 *
 * 归属规则：`listForUser` / `getById` 的调用方必须显式传入是否 admin；
 * 非 admin 只能看到 `published` 的 Agent。
 */
import { agentConfigSchema, agentStatusSchema, type AgentConfig, type AgentDetail, type AgentSummary, type Role } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import { DataCorruptionError, parseJsonColumn } from '../db/json.js'
import type { AgentRow } from '../db/types.js'
import type { Logger } from '../logger.js'
import type { AgentVersionsRepository } from './agentVersions.js'

export interface AgentRecord {
  id: string
  name: string
  description: string
  status: 'draft' | 'published' | 'disabled'
  ownerId: string
  currentVersion: number
  draft: AgentConfig
  createdAt: number
  updatedAt: number
}

export interface InsertAgentInput {
  id: string
  name: string
  description: string
  status: 'draft' | 'published' | 'disabled'
  ownerId: string
  currentVersion: number
  draft: AgentConfig
}

export class AgentsRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly logger: Logger,
    private readonly versions: AgentVersionsRepository,
  ) {}

  private toRecord(row: AgentRow): AgentRecord {
    let draft: AgentConfig
    try {
      draft = parseJsonColumn(agentConfigSchema, row.draft_json, 'agents.draft_json', this.logger)
    } catch (error) {
      throw error instanceof DataCorruptionError ? error : new DataCorruptionError('agents.draft_json', error)
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      status: agentStatusSchema.parse(row.status),
      ownerId: row.owner_id,
      currentVersion: Number(row.current_version),
      draft,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  insert(input: InsertAgentInput): AgentRecord {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO agents (id, name, description, status, owner_id, current_version, draft_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.description,
        input.status,
        input.ownerId,
        input.currentVersion,
        JSON.stringify(input.draft),
        now,
        now,
      )
    return {
      ...input,
      createdAt: now,
      updatedAt: now,
    }
  }

  exists(id: string): boolean {
    return this.db.prepare('SELECT 1 AS ok FROM agents WHERE id = ?').get(id) !== undefined
  }

  getById(id: string): AgentRecord | undefined {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined
    return row === undefined ? undefined : this.toRecord(row)
  }

  listForUser(userId: string, role: Role): AgentRecord[] {
    const rows =
      role === 'admin'
        ? (this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all() as unknown as AgentRow[])
        : (this.db
            .prepare("SELECT * FROM agents WHERE status = 'published' ORDER BY updated_at DESC")
            .all() as unknown as AgentRow[])
    return rows.map((row) => this.toRecord(row))
  }

  /** 管理员可编辑任意 Agent；普通用户没有编辑权限（路由层已限制）。 */
  updateDraft(
    id: string,
    input: { draft: AgentConfig; name: string; description: string },
  ): AgentRecord | undefined {
    const now = Date.now()
    const result = this.db
      .prepare('UPDATE agents SET draft_json = ?, name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(input.draft), input.name, input.description, now, id)
    if (Number(result.changes) === 0) return undefined
    return this.getById(id)
  }

  setStatus(id: string, status: 'draft' | 'published' | 'disabled'): void {
    this.db.prepare('UPDATE agents SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), id)
  }

  setCurrentVersion(id: string, version: number): void {
    this.db
      .prepare('UPDATE agents SET current_version = ?, updated_at = ? WHERE id = ?')
      .run(version, Date.now(), id)
  }

  toSummary(record: AgentRecord): AgentSummary {
    const permissionCount = this.versions.countGrantedTools(record.id, record.currentVersion)
    return {
      id: record.id,
      name: record.name,
      description: record.description,
      status: record.status,
      version: record.currentVersion,
      model: record.draft.model.modelId,
      provider: record.draft.model.provider,
      toolCount: permissionCount,
      updatedAt: record.updatedAt,
    }
  }

  toDetail(record: AgentRecord): AgentDetail {
    // draft.version 与 current_version 解耦：草稿版本始终 >= 已发布版本。
    return {
      ...this.toSummary(record),
      publishedVersion: record.currentVersion > 0 ? record.currentVersion : undefined,
      draft: record.draft,
      versions: this.versions.listByAgent(record.id),
      createdAt: record.createdAt,
      ownerId: record.ownerId,
    }
  }
}
