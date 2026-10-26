/**
 * 审计 tail：子进程把审计 JSONL 追加到 `audit/tool-calls.jsonl`，网关负责
 * 增量读取、zod 校验、幂等落库。子进程不持有数据库连接。
 */
import fs from 'node:fs'
import path from 'node:path'
import { auditRecordSchema } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { AuditRepository } from '../repositories/audit.js'

export interface AuditTailerOptions {
  auditPath: string
  runtimeId: string
  audit: AuditRepository
  logger: Logger
  pollIntervalMs?: number
}

export class AuditTailer {
  private offset = 0
  private remainder = ''
  private timer: NodeJS.Timeout | undefined
  private watcher: fs.FSWatcher | undefined
  private stopped = false

  constructor(private readonly options: AuditTailerOptions) {}

  start(): void {
    if (this.stopped) return
    try {
      fs.mkdirSync(path.dirname(this.options.auditPath), { recursive: true })
      if (!fs.existsSync(this.options.auditPath)) fs.writeFileSync(this.options.auditPath, '')
    } catch (error) {
      this.options.logger.warn('failed to prepare audit file', { auditPath: this.options.auditPath, error })
    }

    // 启动时先从 0 读：INSERT OR IGNORE 会去掉重复记录。
    this.drain()

    try {
      this.watcher = fs.watch(path.dirname(this.options.auditPath), () => {
        try {
          this.drain()
        } catch (error) {
          this.options.logger.error('audit tail failed', error)
        }
      })
      this.watcher.on('error', (error) => this.options.logger.warn('audit watcher error', error))
    } catch (error) {
      this.options.logger.warn('failed to watch audit dir; polling only', { error })
    }

    const interval = this.options.pollIntervalMs ?? 500
    this.timer = setInterval(() => {
      try {
        this.drain()
      } catch (error) {
        this.options.logger.error('audit poll failed', error)
      }
    }, interval)
    this.timer.unref()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 读取新增字节并逐行解析；不完整行留到下次。 */
  drain(): void {
    if (this.stopped) return
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.options.auditPath)
    } catch {
      return
    }
    if (stat.size <= this.offset) return

    const length = stat.size - this.offset
    const buffer = Buffer.alloc(length)
    let fd: number | undefined
    try {
      fd = fs.openSync(this.options.auditPath, 'r')
      fs.readSync(fd, buffer, 0, length, this.offset)
      this.offset += length
    } catch (error) {
      this.options.logger.warn('failed to read audit file', { auditPath: this.options.auditPath, error })
      return
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {
          // 忽略关闭失败。
        }
      }
    }

    const chunk = this.remainder + buffer.toString('utf8')
    const lines = chunk.split('\n')
    this.remainder = lines.pop() ?? ''
    // 防御：异常长的残片说明文件被破坏，丢弃避免内存膨胀。
    if (this.remainder.length > 1_000_000) {
      this.options.logger.warn('audit remainder too large; discarding', { runtimeId: this.options.runtimeId })
      this.remainder = ''
    }

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let value: unknown
      try {
        value = JSON.parse(trimmed)
      } catch (error) {
        this.options.logger.warn('malformed audit line skipped', {
          runtimeId: this.options.runtimeId,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      const parsed = auditRecordSchema.safeParse(value)
      if (!parsed.success) {
        this.options.logger.warn('audit line failed schema; skipped', {
          runtimeId: this.options.runtimeId,
          issues: parsed.error.issues,
        })
        continue
      }
      try {
        this.options.audit.insert(parsed.data)
      } catch (error) {
        this.options.logger.error('failed to persist audit record', { error })
      }
    }
  }
}
