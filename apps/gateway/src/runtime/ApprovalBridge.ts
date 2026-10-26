/**
 * 审批桥：DSH SDK 没有 server→client 审批通道（docs/RESEARCH-SDK.md §5），
 * 因此审批走运行目录下的可信文件通道：
 *
 *   control/approvals/<id>.request.json   子进程（policy 插件）写
 *   control/approvals/<id>.decision.json  网关原子写（.tmp → rename）
 *
 * 规则：任何畸形输入、通道异常、超时都按拒绝处理（fail closed）。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  approvalDecisionFileName,
  approvalDecisionRecordSchema,
  approvalRequestFileName,
  approvalRequestSchema,
  parseApprovalFileName,
  type ApprovalDecision,
  type ApprovalRequest,
} from '@agent-studio/shared'
import type { AgentEvent } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { ApprovalsRepository } from '../repositories/approvals.js'
import type { SseHub } from './SseHub.js'

export interface ApprovalBridgeOptions {
  controlDir: string
  sessionId: string
  runtimeId: string
  userId: string
  approvalTimeoutMs: number
  approvals: ApprovalsRepository
  hub: SseHub
  logger: Logger
  now?: () => number
  /** 轮询兜底间隔（fs.watch 不可靠时仍能发现请求）。 */
  pollIntervalMs?: number
}

const APPROVAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export class ApprovalBridge {
  private readonly approvalsDir: string
  private readonly now: () => number
  private readonly processed = new Set<string>()
  private watcher: fs.FSWatcher | undefined
  private scanTimer: NodeJS.Timeout | undefined
  private expireTimer: NodeJS.Timeout | undefined
  private stopped = false

  constructor(private readonly options: ApprovalBridgeOptions) {
    this.approvalsDir = path.join(options.controlDir, 'approvals')
    this.now = options.now ?? (() => Date.now())
  }

  start(): void {
    if (this.stopped) return
    fs.mkdirSync(this.approvalsDir, { recursive: true })

    try {
      this.watcher = fs.watch(this.approvalsDir, (eventType, fileName) => {
        if (eventType !== 'rename' && eventType !== 'change') return
        const name = typeof fileName === 'string' ? fileName : undefined
        if (name === undefined || !name.endsWith('.request.json')) return
        // fs.watch 回调不能抛异常；这里统一接住。
        try {
          this.scan()
        } catch (error) {
          this.options.logger.error('approval scan failed', error)
        }
      })
      this.watcher.on('error', (error) => this.options.logger.warn('approval watcher error', error))
    } catch (error) {
      this.options.logger.warn('failed to watch approvals dir; polling only', {
        approvalsDir: this.approvalsDir,
        error,
      })
    }

    const pollInterval = this.options.pollIntervalMs ?? 500
    this.scanTimer = setInterval(() => {
      try {
        this.scan()
      } catch (error) {
        this.options.logger.error('approval poll failed', error)
      }
    }, pollInterval)
    this.scanTimer.unref()

    this.expireTimer = setInterval(() => {
      try {
        this.scanExpired()
      } catch (error) {
        this.options.logger.error('approval expiry scan failed', error)
      }
    }, 1000)
    this.expireTimer.unref()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = undefined
    if (this.scanTimer !== undefined) clearInterval(this.scanTimer)
    if (this.expireTimer !== undefined) clearInterval(this.expireTimer)
    this.scanTimer = undefined
    this.expireTimer = undefined
  }

  /** 扫描并接纳新的审批请求；同一 approvalId 只处理一次。 */
  scan(): void {
    if (this.stopped) return
    let entries: string[]
    try {
      entries = fs.readdirSync(this.approvalsDir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }

    for (const fileName of entries) {
      const approvalId = parseApprovalFileName(fileName)
      if (approvalId === undefined) continue
      if (!APPROVAL_ID_PATTERN.test(approvalId)) {
        this.options.logger.warn('approval file with unsafe id ignored', { fileName })
        continue
      }
      if (this.processed.has(approvalId)) continue
      this.processed.add(approvalId)
      this.acceptRequest(approvalId, fileName)
    }
  }

  private acceptRequest(approvalId: string, fileName: string): void {
    const filePath = path.join(this.approvalsDir, fileName)
    let request: ApprovalRequest
    try {
      const raw = fs.readFileSync(filePath, 'utf8')
      const parsed = approvalRequestSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) {
        this.rejectMalformed(approvalId, 'malformed approval request (schema)')
        return
      }
      request = parsed.data
      if (request.approvalId !== approvalId) {
        this.rejectMalformed(approvalId, 'malformed approval request (id mismatch)')
        return
      }
    } catch (error) {
      this.rejectMalformed(approvalId, 'malformed approval request (unreadable JSON)')
      this.options.logger.warn('failed to read approval request', { approvalId, error })
      return
    }

    const now = this.now()
    // 稳定 runtimeId 会复用同一个 control 目录：同一 approvalId 只接纳一次，
    // 避免重启后重复落库/重复弹审批。
    const existing = this.options.approvals.getByApprovalId(this.options.sessionId, approvalId)
    if (existing !== undefined) {
      if (existing.status === 'pending') {
        this.writeDecision(approvalId, 'rejected', 'system', 'gateway restarted')
        this.options.approvals.updateDecision(existing.id, 'expired', 'system', now)
        this.publishDecided(approvalId, 'expired')
      } else if (!fs.existsSync(path.join(this.approvalsDir, approvalDecisionFileName(approvalId)))) {
        // 已有终态但没有决定文件：补写拒绝，避免插件一直等到超时。
        this.writeDecision(approvalId, 'rejected', 'system', `approval already ${existing.status}`)
      }
      return
    }

    const expiresAt = Math.min(request.expiresAt, now + this.options.approvalTimeoutMs)
    const row = this.options.approvals.insert({
      sessionId: this.options.sessionId,
      approvalId,
      tool: request.tool,
      description: request.description,
      argumentsPreview: request.argumentsPreview,
      argumentsDigest: request.argumentsDigest,
      expiresAt,
    })

    if (expiresAt <= now) {
      this.writeDecision(approvalId, 'rejected', 'system', 'expired before delivery')
      this.options.approvals.updateDecision(row.id, 'expired', 'system', now)
      this.publishDecided(approvalId, 'expired')
      return
    }

    this.options.hub.publish({
      type: 'approval.required',
      sessionId: this.options.sessionId,
      runtimeId: this.options.runtimeId,
      approvalId,
      tool: request.tool,
      description: request.description,
      argumentsPreview: request.argumentsPreview,
      expiresAt,
      at: now,
    })
  }

  /** 网关（或管理员）作出决定：先落决定文件，再更新数据库，最后推送事件。 */
  decide(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
  ): { ok: boolean; status: 'allowed' | 'rejected' | 'cancelled' | 'expired' | 'pending' | 'missing' } {
    const row = this.options.approvals.getByApprovalId(this.options.sessionId, approvalId)
    if (row === undefined) return { ok: false, status: 'missing' }
    if (row.status !== 'pending') return { ok: false, status: row.status }

    const now = this.now()
    if (row.expires_at <= now) {
      this.writeDecision(approvalId, 'rejected', 'system', 'expired')
      this.options.approvals.updateDecision(row.id, 'expired', 'system', now)
      this.publishDecided(approvalId, 'expired')
      return { ok: false, status: 'expired' }
    }

    this.writeDecision(approvalId, decision, decidedBy, reason)
    const updated = this.options.approvals.updateDecision(row.id, decision, decidedBy, now)
    this.publishDecided(approvalId, decision)
    return { ok: true, status: updated?.status ?? 'pending' }
  }

  /** 运行时关闭前：所有未决审批写拒绝决定并置 expired（fail closed）。 */
  expirePending(reason: string): void {
    const now = this.now()
    for (const row of this.options.approvals.listPendingBySession(this.options.sessionId)) {
      this.writeDecision(row.approval_id, 'rejected', 'system', reason)
      this.options.approvals.updateDecision(row.id, 'expired', 'system', now)
      this.publishDecided(row.approval_id, 'expired')
    }
  }

  /** 定时扫描：过期 → 拒绝（绝不是 allowed）。 */
  scanExpired(): void {
    if (this.stopped) return
    const now = this.now()
    const expired = this.options.approvals.listExpiredPending(now)
    for (const row of expired) {
      this.writeDecision(row.approval_id, 'rejected', 'system', 'approval timed out')
      this.options.approvals.updateDecision(row.id, 'expired', 'system', now)
      this.publishDecided(row.approval_id, 'expired')
    }
  }

  private publishDecided(approvalId: string, decision: 'allowed-once' | 'rejected' | 'cancelled' | 'expired'): void {
    const event: AgentEvent = {
      type: 'approval.decided',
      sessionId: this.options.sessionId,
      runtimeId: this.options.runtimeId,
      approvalId,
      decision,
      at: this.now(),
    }
    this.options.hub.publish(event)
    this.options.logger.info('approval decision published', { approvalId, decision })
  }

  /** 原子写决定文件；失败按拒绝处理（插件侧会因缺少文件而拒绝）。 */
  private writeDecision(
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
  ): void {
    const record = approvalDecisionRecordSchema.parse({
      approvalId,
      decision,
      decidedBy,
      decidedAt: this.now(),
      ...(reason === undefined ? {} : { reason }),
    })
    const target = path.join(this.approvalsDir, approvalDecisionFileName(approvalId))
    const temp = `${target}.tmp`
    try {
      fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, 'utf8')
      fs.renameSync(temp, target)
    } catch (error) {
      this.options.logger.error('failed to write approval decision; treating as rejected', {
        approvalId,
        error,
      })
      try {
        fs.rmSync(temp, { force: true })
      } catch {
        // 清理失败不影响 fail-closed 语义。
      }
    }
  }

  private rejectMalformed(approvalId: string, reason: string): void {
    this.writeDecision(approvalId, 'rejected', 'system', reason)
    this.options.logger.warn('rejected malformed approval request', { approvalId, reason })
  }

  /** 启动修复：为遗留 pending 写拒绝决定（如果请求文件还在）。 */
  rejectPendingOnBoot(): void {
    for (const row of this.options.approvals.listPendingBySession(this.options.sessionId)) {
      const requestPath = path.join(this.approvalsDir, approvalRequestFileName(row.approval_id))
      if (!fs.existsSync(requestPath)) continue
      this.writeDecision(row.approval_id, 'rejected', 'system', 'gateway restarted')
      this.options.approvals.updateDecision(row.id, 'expired', 'system', this.now())
    }
  }

  getUserId(): string {
    return this.options.userId
  }
}
