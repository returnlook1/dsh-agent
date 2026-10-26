/**
 * 幂等种子：admin/admin123、demo/demo123、示例 MCP（默认禁用）。
 *
 * 只在用户不存在时创建；密码只在首次创建时哈希。
 */
import type { GatewayDatabase } from './database.js'
import type { Logger } from '../logger.js'
import { hashPassword } from '../auth/passwords.js'
import { UsersRepository } from '../repositories/users.js'
import { McpServersRepository } from '../repositories/mcp.js'

export interface SeedResult {
  createdUsers: string[]
  createdMcpServers: string[]
}

export function seedDatabase(db: GatewayDatabase, logger: Logger): SeedResult {
  const users = new UsersRepository(db)
  const mcpServers = new McpServersRepository(db, logger)
  const createdUsers: string[] = []
  const createdMcpServers: string[] = []

  const presets = [
    { username: 'admin', displayName: 'Administrator', password: 'admin123', role: 'admin' as const },
    { username: 'demo', displayName: 'Demo User', password: 'demo123', role: 'user' as const },
  ]

  for (const preset of presets) {
    if (users.findByUsername(preset.username) !== undefined) continue
    users.create({
      username: preset.username,
      displayName: preset.displayName,
      passwordHash: hashPassword(preset.password),
      role: preset.role,
    })
    createdUsers.push(preset.username)
  }

  if (mcpServers.get('example') === undefined) {
    mcpServers.insert({
      id: 'example',
      name: 'Example MCP (disabled)',
      transport: 'stdio',
      command: 'node',
      args: [],
      envKeys: [],
      enabled: false,
      readOnly: true,
    })
    createdMcpServers.push('example')
  }

  if (createdUsers.length > 0 || createdMcpServers.length > 0) {
    logger.info('database seeded', { users: createdUsers, mcpServers: createdMcpServers })
  }
  return { createdUsers, createdMcpServers }
}
