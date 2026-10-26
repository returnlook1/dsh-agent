/** 用户仓库。用户只在种子/运维时创建，没有公开注册接口。 */
import { randomUUID } from 'node:crypto'
import type { UserDto } from '@agent-studio/shared'
import type { GatewayDatabase } from '../db/database.js'
import type { UserRow } from '../db/types.js'

export interface CreateUserInput {
  username: string
  displayName: string
  passwordHash: string
  role: 'admin' | 'user'
}

export class UsersRepository {
  constructor(private readonly db: GatewayDatabase) {}

  create(input: CreateUserInput): UserRow {
    const row: UserRow = {
      id: randomUUID(),
      username: input.username,
      display_name: input.displayName,
      password_hash: input.passwordHash,
      role: input.role,
      created_at: Date.now(),
    }
    this.db
      .prepare(
        `INSERT INTO users (id, username, display_name, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.username, row.display_name, row.password_hash, row.role, row.created_at)
    return row
  }

  findByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
  }

  findById(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
    return Number(row.count)
  }

  toDto(row: UserRow): UserDto {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
    }
  }
}
