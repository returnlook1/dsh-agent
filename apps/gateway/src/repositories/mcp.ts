/** MCP 服务器配置仓库。不落库任何密钥；只保存环境变量键名。 */
import { mcpServerConfigSchema, type McpServerConfig, type McpServerDto } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import { parseJsonColumn } from '../db/json.js'
import type { McpServerRow } from '../db/types.js'
import type { Logger } from '../logger.js'

type McpPayload = Pick<McpServerConfig, 'command' | 'args' | 'url' | 'envKeys' | 'readOnly'>

const payloadSchema = mcpServerConfigSchema.pick({
  command: true,
  args: true,
  url: true,
  envKeys: true,
  readOnly: true,
})

export class McpServersRepository {
  constructor(
    private readonly db: GatewayDatabase,
    private readonly logger: Logger,
  ) {}

  private toDto(row: McpServerRow): McpServerDto {
    const payload = parseJsonColumn(payloadSchema, row.config_json, 'mcp_servers.config_json', this.logger)
    return {
      id: row.id,
      name: row.name,
      transport: row.transport as McpServerDto['transport'],
      ...payload,
      enabled: Number(row.enabled) === 1,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    }
  }

  list(): McpServerDto[] {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY name ASC').all() as unknown as McpServerRow[]
    return rows.map((row) => this.toDto(row))
  }

  listEnabled(): McpServerDto[] {
    const rows = this.db
      .prepare('SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC')
      .all() as unknown as McpServerRow[]
    return rows.map((row) => this.toDto(row))
  }

  get(id: string): McpServerDto | undefined {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined
    return row === undefined ? undefined : this.toDto(row)
  }

  insert(config: McpServerConfig): McpServerDto {
    const now = Date.now()
    const payload: McpPayload = {
      command: config.command,
      args: config.args,
      url: config.url,
      envKeys: config.envKeys,
      readOnly: config.readOnly,
    }
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, transport, config_json, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(config.id, config.name, config.transport, JSON.stringify(payload), config.enabled ? 1 : 0, now, now)
    return { ...config, createdAt: now, updatedAt: now }
  }

  update(id: string, config: McpServerConfig): McpServerDto | undefined {
    const payload: McpPayload = {
      command: config.command,
      args: config.args,
      url: config.url,
      envKeys: config.envKeys,
      readOnly: config.readOnly,
    }
    const result = this.db
      .prepare(
        `UPDATE mcp_servers
            SET name = ?, transport = ?, config_json = ?, enabled = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(config.name, config.transport, JSON.stringify(payload), config.enabled ? 1 : 0, Date.now(), id)
    if (Number(result.changes) === 0) return undefined
    return this.get(id)
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const result = this.db
      .prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, Date.now(), id)
    return Number(result.changes) > 0
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    return Number(result.changes) > 0
  }
}
