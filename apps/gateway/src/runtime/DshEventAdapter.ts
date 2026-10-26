/**
 * DSH 通知 → 网关 `AgentEvent` 的适配器。
 *
 * 已核实事实（docs/RESEARCH-SDK.md）：
 * - 线上只有 4 个通知；没有 token 级增量，最细粒度是每个 step 一条
 *   `assistant/message`，因此 `message.delta.mode` 只能是 `'message'`；
 * - `turn/end.reason.kind` 是失败/取消的唯一可靠来源；
 * - `session.status{status:'idle'}` 是"本轮活动结束"的官方口径。
 *
 * 本类同时承担持久化副作用（同步 SQLite）与 turn 上限计数。
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, SessionStatus, ToolCallRecord, ToolRisk } from '@agent-studio/shared'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { Logger } from '../logger.js'
import type { MessagesRepository } from '../repositories/messages.js'
import type { SessionsRepository } from '../repositories/sessions.js'
import type { SseHub } from './SseHub.js'

const SENSITIVE_KEY = /token|key|secret|password|authorization/i
const PREVIEW_LIMIT = 300

export interface DshEventAdapterDeps {
  sessionId: string
  userId: string
  runtimeId: string
  agentId: string
  agentVersion: number
  dshSessionId: string
  maxTurns: number
  hub: SseHub
  sessions: SessionsRepository
  messages: MessagesRepository
  logger: Logger
  toolLookup?: { riskFor(name: string): ToolRisk | undefined }
  /** 超出 maxTurns 时关闭运行时（由 manager 注入）。 */
  onMaxTurns?: () => void
  /** 终止事件回调（manager 用来更新运行时状态/空闲计时）。 */
  onTerminal?: (event: AgentEvent) => void
  now?: () => number
}

interface CallRecord {
  record: ToolCallRecord
  messageId?: string
  startedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function maskValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '***'
  if (Array.isArray(value)) return value.map((item) => maskValue(item, depth + 1))
  if (isRecord(value)) {
    const masked: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
      masked[key] = SENSITIVE_KEY.test(key) ? '***' : maskValue(entry, depth + 1)
    }
    return masked
  }
  return value
}

/**
 * 参数摘要：JSON 解析成功时脱敏敏感键，失败时原样截断。
 * 最长 300 字符（docs/IMPL-GATEWAY.md §6）。
 */
export function sanitizeArgumentsPreview(raw: unknown): string {
  let text: string
  if (typeof raw === 'string') {
    try {
      text = JSON.stringify(maskValue(JSON.parse(raw)))
    } catch {
      text = raw
    }
  } else if (raw === undefined || raw === null) {
    return ''
  } else {
    text = JSON.stringify(maskValue(raw)) ?? ''
  }
  return text.length > PREVIEW_LIMIT ? text.slice(0, PREVIEW_LIMIT) : text
}

export class DshEventAdapter {
  private readonly seenMessageIds = new Set<string>()
  private readonly callRecords = new Map<string, CallRecord>()
  private readonly messageToolCalls = new Map<string, ToolCallRecord[]>()
  private readonly now: () => number

  private terminal = false
  private runActive = false
  private runStartedEmitted = false
  private runId: string | undefined
  private turnCount = 0
  private lastAssistantText = ''
  private currentAssistantMessageId: string | undefined

  constructor(private readonly deps: DshEventAdapterDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** RunService/manager 在 prompt 前调用：开启新的一轮（不立即发事件，等首个通知）。 */
  beginRun(): void {
    this.terminal = false
    this.runActive = true
    this.runStartedEmitted = false
    this.runId = randomUUID()
    this.turnCount = 0
    this.currentAssistantMessageId = undefined
  }

  isTerminal(): boolean {
    return this.terminal
  }

  /** 当前是否有进行中的 turn（空闲回收必须避开）。 */
  hasActiveRun(): boolean {
    return this.runActive && !this.terminal
  }

  getTurnCount(): number {
    return this.turnCount
  }

  handleNotification(notification: HarnessNotification): void {
    if (this.terminal) return
    try {
      if (notification.method === 'session.event') {
        const params = notification.params
        if (asString(params.sessionId) !== this.deps.dshSessionId) return
        if (!isRecord(params.event)) {
          this.deps.logger.warn('malformed session.event payload', { runtimeId: this.deps.runtimeId })
          return
        }
        this.handleSessionEvent(params.event)
        return
      }
      if (notification.method === 'session.status') {
        const params = notification.params
        if (asString(params.sessionId) !== this.deps.dshSessionId) return
        if (params.status === 'running') {
          this.ensureRunStarted()
        } else if (params.status === 'idle') {
          this.handleIdle()
        }
        return
      }
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        // 受限 Profile 不挂 subagent 插件；即使收到也仅记录，不映射为业务事件。
        this.deps.logger.debug('ignoring subagent notification', { method: notification.method })
      }
    } catch (error) {
      // 单条畸形事件不能打断整个通知派发循环。
      this.deps.logger.error('failed to map DSH notification', {
        method: notification.method,
        runtimeId: this.deps.runtimeId,
        error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
      })
    }
  }

  /** 传输层关闭 / 子进程退出。 */
  handleTransportClosed(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.finish(
      {
        type: 'agent.failed',
        sessionId: this.deps.sessionId,
        runtimeId: this.deps.runtimeId,
        message: message === '' ? '运行时已关闭' : message,
        code: 'runtime-closed',
        at: this.now(),
      },
      'failed',
    )
  }

  /** 运行前失败（spawn/initialize/prompt reject）。 */
  failRun(message: string, code = 'runtime-error'): void {
    this.finish(
      {
        type: 'agent.failed',
        sessionId: this.deps.sessionId,
        runtimeId: this.deps.runtimeId,
        message,
        code,
        at: this.now(),
      },
      'failed',
    )
  }

  /** 主动停止（关闭运行时）时保证 SSE 有终止事件。 */
  abortRun(reason: string): void {
    this.finish(
      {
        type: 'agent.failed',
        sessionId: this.deps.sessionId,
        runtimeId: this.deps.runtimeId,
        message: reason,
        code: 'aborted',
        at: this.now(),
      },
      'idle',
    )
  }

  private handleSessionEvent(event: Record<string, unknown>): void {
    const type = asString(event.type)
    if (type === undefined) return
    const time = asNumber(event.time) ?? this.now()
    const data = isRecord(event.data) ? event.data : {}

    this.ensureRunStarted()

    switch (type) {
      case 'turn/start': {
        this.turnCount += 1
        if (this.turnCount > this.deps.maxTurns) {
          this.finish(
            {
              type: 'run.limit',
              sessionId: this.deps.sessionId,
              runtimeId: this.deps.runtimeId,
              reason: 'max-turns',
              detail: `轮次超过上限 ${this.deps.maxTurns}`,
              at: time,
            },
            'idle',
          )
          this.deps.logger.warn('max turns exceeded; closing runtime', {
            sessionId: this.deps.sessionId,
            maxTurns: this.deps.maxTurns,
          })
          this.deps.onMaxTurns?.()
        }
        return
      }
      case 'assistant/message': {
        this.handleAssistantMessage(data, time)
        return
      }
      case 'tool/call': {
        this.handleToolCall(data, time)
        return
      }
      case 'tool/result': {
        this.handleToolResult(data, time)
        return
      }
      case 'turn/end': {
        this.handleTurnEnd(data, time)
        return
      }
      case 'approval/asked':
      case 'approval/decided': {
        // SDK 线路上没有可回写的审批通道；这里只观测，业务审批走 ApprovalBridge。
        this.deps.logger.debug('observed DSH approval event', { type, runtimeId: this.deps.runtimeId })
        return
      }
      default:
        return
    }
  }

  private ensureRunStarted(): void {
    if (this.runStartedEmitted) return
    if (!this.runActive) {
      this.runActive = true
      this.runId = randomUUID()
    }
    this.runStartedEmitted = true
    this.deps.sessions.updateStatus(this.deps.sessionId, 'running')
    this.deps.hub.publish({
      type: 'run.started',
      sessionId: this.deps.sessionId,
      runtimeId: this.deps.runtimeId,
      runId: this.runId ?? randomUUID(),
      at: this.now(),
    })
  }

  private handleAssistantMessage(data: Record<string, unknown>, time: number): void {
    const message = isRecord(data.message) ? data.message : undefined
    const messageId = message === undefined ? undefined : asString(message.id)
    if (messageId === undefined) {
      this.deps.logger.warn('assistant/message without message.id; ignored', { runtimeId: this.deps.runtimeId })
      return
    }
    // 去重键就是 data.message.id（重连/重复通知不能产生两条消息）。
    if (this.seenMessageIds.has(messageId)) return
    this.seenMessageIds.add(messageId)

    const content = message?.content
    const textBlocks = Array.isArray(content) ? content : []
    const text = textBlocks
      .map((block) => {
        if (!isRecord(block)) return ''
        return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
      })
      .join('')

    const interrupted = data.interrupted === true
    if (!interrupted && text !== '') this.lastAssistantText = text

    if (text !== '') {
      const row = this.deps.messages.append({
        sessionId: this.deps.sessionId,
        role: 'assistant',
        content: text,
      })
      this.currentAssistantMessageId = row.id
      this.messageToolCalls.set(row.id, [])
    }

    this.deps.hub.publish({
      type: 'message.delta',
      sessionId: this.deps.sessionId,
      runtimeId: this.deps.runtimeId,
      text,
      messageId,
      // 粒度如实：DSH 只有"每个 step 一条已提交消息"，不存在 token 级增量。
      mode: 'message',
      at: time,
    })
  }

  private handleToolCall(data: Record<string, unknown>, time: number): void {
    const callId = asString(data.callId)
    const name = asString(data.name)
    if (callId === undefined || name === undefined) return
    if (this.callRecords.has(callId)) return

    const preview = sanitizeArgumentsPreview(data.arguments)
    const record: ToolCallRecord = {
      callId,
      tool: name,
      status: 'running',
    }
    if (preview !== '') record.argumentsPreview = preview

    const entry: CallRecord = { record, startedAt: time }
    const messageId = this.currentAssistantMessageId
    if (messageId !== undefined) {
      entry.messageId = messageId
      const calls = this.messageToolCalls.get(messageId) ?? []
      calls.push(record)
      this.messageToolCalls.set(messageId, calls)
      this.deps.messages.updateToolCalls(messageId, calls)
    }
    this.callRecords.set(callId, entry)

    this.deps.hub.publish({
      type: 'tool.started',
      sessionId: this.deps.sessionId,
      runtimeId: this.deps.runtimeId,
      callId,
      tool: name,
      ...(preview === '' ? {} : { argumentsPreview: preview }),
      ...(this.deps.toolLookup?.riskFor(name) === undefined
        ? {}
        : { risk: this.deps.toolLookup.riskFor(name) }),
      at: time,
    })
  }

  private handleToolResult(data: Record<string, unknown>, time: number): void {
    const message = isRecord(data.message) ? data.message : {}
    const callId = asString(message.toolCallId) ?? asString(data.callId)
    if (callId === undefined) return
    const entry = this.callRecords.get(callId)
    const toolName = entry?.record.tool ?? 'unknown'
    const isError = message.isError === true || data.error !== undefined
    const errorRecord = isRecord(data.error) ? data.error : undefined
    const errorText =
      asString(errorRecord?.message) ?? asString(errorRecord?.reason) ?? asString(errorRecord?.code)

    const durationMs = entry === undefined ? undefined : Math.max(0, time - entry.startedAt)
    if (entry !== undefined) {
      entry.record.status = isError ? 'failed' : 'succeeded'
      if (errorText !== undefined) entry.record.error = errorText
      if (durationMs !== undefined) entry.record.durationMs = durationMs
      if (entry.messageId !== undefined) {
        const calls = this.messageToolCalls.get(entry.messageId) ?? []
        this.deps.messages.updateToolCalls(entry.messageId, calls)
      }
    }

    this.deps.hub.publish({
      type: 'tool.completed',
      sessionId: this.deps.sessionId,
      runtimeId: this.deps.runtimeId,
      callId,
      tool: toolName,
      success: !isError,
      ...(errorText === undefined ? {} : { error: errorText }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(entry?.record.argumentsPreview === undefined
        ? {}
        : { argumentsPreview: entry.record.argumentsPreview }),
      at: time,
    })
  }

  private handleTurnEnd(data: Record<string, unknown>, time: number): void {
    const reason = isRecord(data.reason) ? data.reason : undefined
    const kind = asString(reason?.kind)
    if (kind === 'completed') {
      // 正常完成：等 session.status idle 再发 agent.completed（官方口径）。
      return
    }
    if (kind === 'forked') {
      // fork 边界不是失败。
      return
    }
    if (kind === 'error') {
      const failure = isRecord(reason?.error) ? reason.error : undefined
      const message = asString(failure?.message) ?? '模型调用失败'
      const code = asString(failure?.code) ?? 'llm-error'
      this.failRun(message, code)
      return
    }
    if (kind === 'aborted') {
      const cause = isRecord(reason?.reason) ? reason.reason : undefined
      const causeKind = asString(cause?.kind) ?? 'unknown'
      this.finish(
        {
          type: 'agent.failed',
          sessionId: this.deps.sessionId,
          runtimeId: this.deps.runtimeId,
          message: `本轮已被中止（${causeKind}）`,
          code: 'aborted',
          at: time,
        },
        'idle',
      )
      return
    }
    if (kind === 'max-tokens') {
      this.failRun('输出达到 token 上限（max-tokens）', 'max-tokens')
      return
    }
    if (kind === 'blocked') {
      this.failRun('本轮被策略阻止（blocked）', 'blocked')
      return
    }
    if (kind === 'interrupted') {
      this.failRun('本轮被中断（interrupted）', 'interrupted')
    }
  }

  private handleIdle(): void {
    if (this.terminal) return
    if (!this.runStartedEmitted) return
    this.finish(
      {
        type: 'agent.completed',
        sessionId: this.deps.sessionId,
        runtimeId: this.deps.runtimeId,
        text: this.lastAssistantText,
        dshSessionId: this.deps.dshSessionId,
        at: this.now(),
      },
      'idle',
    )
  }

  private finish(event: AgentEvent, status: SessionStatus): void {
    if (this.terminal) return
    this.terminal = true
    this.runActive = false
    this.deps.sessions.updateStatus(this.deps.sessionId, status)
    this.deps.sessions.touch(this.deps.sessionId)
    this.deps.hub.publish(event)
    this.deps.onTerminal?.(event)
  }
}
