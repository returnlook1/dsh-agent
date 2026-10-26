/** Agent 版本与工具授权仓库。版本发布后不可修改，只允许追加新版本。 */
import {
  agentConfigSchema,
  configWarningsSchema,
  toolActionSchema,
  type AgentConfig,
  type AgentVersionDto,
  type ConfigWarning,
  type ToolAction,
} from '../schemas.js'
import type { GatewayDatabase } from '../db/database.js'
import { parseJsonColumn } from '../db/json.js'
import type { AgentVersionRow, AgentPermissionRow } from '../db/types.js'
import type { Logger } from '../logger.js'

export interface InsertVersionInput {
  agentId: string
  version: number
  config: AgentConfig
  createdBy: string
  verified: boolean
  warnings: ConfigWarning[]
}

function versionKey(agentId: string, version: number): string {
  return `${agentId}@${version}`
}

export class AgentVersionsRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly logger: Logger,
  ) {}

  nextVersion(agentId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM agent_versions WHERE agent_id = ?')
      .get(agentId) as { version: number }
    return Number(row.version) + 1
  }

  insert(input: InsertVersionInput): void {
    this.db
      .prepare(
        `INSERT INTO agent_versions (agent_id, version, config_json, created_at, created_by, verified, warnings_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.agentId,
        input.version,
        JSON.stringify(input.config),
        Date.now(),
        input.createdBy,
        input.verified ? 1 : 0,
        JSON.stringify(input.warnings),
      )
  }

  get(agentId: string, version: number): AgentVersionDto | undefined {
    const row = this.db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?')
      .get(agentId, version) as AgentVersionRow | undefined
    return row === undefined ? undefined : this.toDto(row)
  }

  listByAgent(agentId: string): AgentVersionDto[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC')
      .all(agentId) as unknown as AgentVersionRow[]
    return rows.map((row) => this.toDto(row))
  }

  replacePermissions(agentId: string, version: number, tools: Record<string, ToolAction>): void {
    const key = versionKey(agentId, version)
    this.db.prepare('DELETE FROM agent_permissions WHERE version_id = ?').run(key)
    const statement = this.db.prepare(
      'INSERT INTO agent_permissions (version_id, tool_name, action) VALUES (?, ?, ?)',
    )
    for (const [toolName, action] of Object.entries(tools)) {
      statement.run(key, toolName, action)
    }
  }

  listPermissions(agentId: string, version: number): Record<string, ToolAction> {
    const rows = this.db
      .prepare('SELECT tool_name, action FROM agent_permissions WHERE version_id = ?')
      .all(versionKey(agentId, version)) as unknown as AgentPermissionRow[]
    const result: Record<string, ToolAction> = {}
    for (const row of rows) result[row.tool_name] = toolActionSchema.parse(row.action)
    return result
  }

  countGrantedTools(agentId: string, version: number): number {
    if (version <= 0) return 0
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_permissions WHERE version_id = ? AND action IN ('allow','ask')")
      .get(versionKey(agentId, version)) as { count: number }
    return Number(row.count)
  }

  private toDto(row: AgentVersionRow): AgentVersionDto {
    return {
      agentId: row.agent_id,
      version: Number(row.version),
      createdAt: Number(row.created_at),
      createdBy: row.created_by,
      config: parseJsonColumn(agentConfigSchema, row.config_json, 'agent_versions.config_json', this.logger),
      verified: Number(row.verified) === 1,
      warnings: parseJsonColumn(
        configWarningsSchema,
        row.warnings_json,
        'agent_versions.warnings_json',
        this.logger,
      ),
    }
  }
}
