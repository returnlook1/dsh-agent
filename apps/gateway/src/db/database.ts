/**
 * `node:sqlite` 封装：打开库、设置 PRAGMA、执行迁移、提供同步事务。
 *
 * 全部访问是同步的（`DatabaseSync`）——Fastify 处理器里直接调用即可，
 * 单机 SQLite + WAL 下写入是毫秒级；长事务不允许跨 await。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Logger } from '../logger.js'
import { MIGRATIONS } from './migrations.js'

export interface StatementLike {
  all(...params: Array<string | number | null>): unknown[]
  get(...params: Array<string | number | null>): unknown
  run(...params: Array<string | number | null>): { changes: number; lastInsertRowid: number | bigint }
}

export class GatewayDatabase {
  readonly raw: DatabaseSync
  private readonly logger: Logger
  private closed = false

  constructor(filePath: string, logger: Logger) {
    this.logger = logger
    if (filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
    }
    this.raw = new DatabaseSync(filePath)
    this.raw.exec('PRAGMA journal_mode = WAL')
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    this.raw.exec('PRAGMA synchronous = NORMAL')
  }

  exec(sql: string): void {
    this.raw.exec(sql)
  }

  prepare(sql: string): StatementLike {
    return this.raw.prepare(sql) as unknown as StatementSync as unknown as StatementLike
  }

  /** 顺序应用未执行的迁移；每个迁移单独一个事务。 */
  migrate(): void {
    this.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `)
    const appliedRows = this.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>
    const applied = new Set(appliedRows.map((row) => Number(row.version)))
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue
      this.transaction(() => {
        this.exec(migration.sql)
        this.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
          migration.version,
          Date.now(),
        )
      })
      this.logger.info('db migration applied', { version: migration.version, name: migration.name })
    }
  }

  transaction<T>(work: () => T): T {
    this.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.exec('ROLLBACK')
      } catch {
        // 回滚失败时保留原始错误。
      }
      throw error
    }
  }

  ping(): boolean {
    try {
      this.prepare('SELECT 1 AS ok').get()
      return true
    } catch {
      return false
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.raw.close()
    } catch (error) {
      this.logger.warn('db close failed', error)
    }
  }
}
