/**
 * 一个 turn 内：DSH 通知 → 业务 `ServiceEvent`（docs/SERVICE.md §6）。
 *
 * 事实基线（docs/RESEARCH-SDK.md）：
 * - 线上只有 4 个通知，**没有 token 级增量**，最细粒度是每个 step 一条已提交的
 *   `assistant/message`；因此这里绝不伪造 delta，`message.completed` 就是一段完整文本；
 * - `assistant/message` 用 `data.message.id` 去重（重连/重复通知不能产生两条）；
 * - `text` 只拼 `type === 'text'` 的内容块（`reasoning` / `tool-call` / `image` 不算）；
 * - `turn/end{reason.kind:'error'}` 是模型失败的唯一可靠来源 → `message.failed{TURN_ERROR}`；
 * - `session.status{status:'idle'}` 是本轮结束的官方口径；若整轮没有任何助手文本，
 *   以 `message.failed{TURN_EMPTY}` 收尾（前端不会看到空气泡）。
 *
 * 终止语义：`onTerminal` 只在**第一次**终止时触发，SSE 路由据此恰好结束一次。
 */
import type { MessageDto, ToolCallRecord } from '@agent-studio/shared'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { Logger } from '../logger.js'
import type { ServiceEvent } from '@agent-studio/shared'

const SENSITIVE_KEY = /token|key|secret|password|authorization/i
const PREVIEW_LIMIT = 300

export type TurnOutcome = 'idle' | 'failed'

export interface TurnEventAdapterDeps {
  conversationId: string
  /** 该对话在 DSH 运行时里的 session id。 */
  sessionId: string
  publish: (event: ServiceEvent) => void
  /** 落库一条助手消息，返回其服务侧 id（SSE 的 messageId 用同一个 id）。 */
  persistAssistantMessage: (input: { text: string; toolCalls: ToolCallRecord[] }) => MessageDto
  /** 工具调用状态变化后回写（JSONL 只能整体重写）。 */
  updateToolCalls: (messageId: string, toolCalls: ToolCallRecord[]) => void
  /** 本轮终止（只触发一次）。 */
  onTerminal: (outcome: TurnOutcome) => void
  logger: Logger
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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

/** 参数摘要：JSON 能解析就脱敏敏感键，否则原样截断；最长 300 字符。 */
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

interface CallRecord {
  record: ToolCallRecord
  startedAt: number
  messageId?: string
}

export class TurnEventAdapter {
  private readonly seenAssistantIds = new Set<string>()
  private readonly calls = new Map<string, CallRecord>()
  /** 还没挂到某条助手消息上的工具调用（等下一次 assistant/message 一起落库）。 */
  private pending: ToolCallRecord[] = []
  private readonly attached = new Map<string, ToolCallRecord[]>()

  private currentMessageId: string | undefined
  private assistantTexts = 0
  private terminal = false
  private failure: { code: string; message: string } | undefined
  private readonly now: () => number

  constructor(private readonly deps: TurnEventAdapterDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  get terminated(): boolean {
    return this.terminal
  }

  /** 已产出的助手文本条数（0 = 本轮没有可用回答）。 */
  get assistantMessageCount(): number {
    return this.assistantTexts
  }

  /** 终止原因（失败时），供对话记录写 `lastError`。 */
  get lastFailure(): { code: string; message: string } | undefined {
    return this.failure
  }

  /** 传输层关闭 / spawn 失败 / 超时：统一转成 `message.failed`。 */
  fail(code: string, message: string): void {
    this.finishFailed(code, message)
  }

  handleNotification(notification: HarnessNotification): void {
    if (this.terminal) return
    try {
      if (notification.method === 'session.event') {
        const params = notification.params
        if (asString(params.sessionId) !== this.deps.sessionId) return
        if (!isRecord(params.event)) {
          this.deps.logger.warn('malformed session.event payload', { sessionId: this.deps.sessionId })
          return
        }
        this.handleSessionEvent(params.event)
        return
      }
      if (notification.method === 'session.status') {
        const params = notification.params
        if (asString(params.sessionId) !== this.deps.sessionId) return
        if (params.status === 'idle') this.handleIdle()
        return
      }
      // subagent.* 在受限 profile 里不会出现；即使出现也不是业务事件。
    } catch (error) {
      // 单条畸形事件不能打断通知泵。
      this.deps.logger.error('failed to map DSH notification', {
        sessionId: this.deps.sessionId,
        method: notification.method,
        error: error instanceof Error ? { name: error.name, message: error.message } : error,
      })
    }
  }

  private handleSessionEvent(event: Record<string, unknown>): void {
    const type = asString(event.type)
    if (type === undefined) return
    const time = asNumber(event.time) ?? this.now()
    const data = isRecord(event.data) ? event.data : {}

    switch (type) {
      case 'assistant/message':
        this.handleAssistantMessage(data)
        return
      case 'tool/call':
        this.handleToolCall(data, time)
        return
      case 'tool/result':
        this.handleToolResult(data, time)
        return
      case 'turn/end':
        this.handleTurnEnd(data)
        return
      default:
        return
    }
  }

  private handleAssistantMessage(data: Record<string, unknown>): void {
    const message = isRecord(data.message) ? data.message : undefined
    const dshMessageId = message === undefined ? undefined : asString(message.id)
    if (dshMessageId === undefined) {
      this.deps.logger.warn('assistant/message without message.id; ignored', { sessionId: this.deps.sessionId })
      return
    }
    // 去重键就是 data.message.id。
    if (this.seenAssistantIds.has(dshMessageId)) return
    this.seenAssistantIds.add(dshMessageId)

    const content = message?.content
    // 只拼 text 块；reasoning / tool-call / image 一律不进入 message.completed。
    const text = (Array.isArray(content) ? content : [])
      .map((block) => (isRecord(block) && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('')
    if (text.trim() === '') {
      // 纯工具调用的 step：没有可见文本，不发事件（工具事件已经表达清楚了）。
      return
    }

    const toolCalls = this.pending
    const stored = this.deps.persistAssistantMessage({ text, toolCalls })
    if (toolCalls.length > 0) {
      this.attached.set(stored.id, toolCalls)
      for (const record of toolCalls) {
        const callId = record.callId
        const entry = this.calls.get(callId)
        if (entry !== undefined) entry.messageId = stored.id
      }
      this.pending = []
    }
    this.currentMessageId = stored.id
    this.assistantTexts += 1
    this.deps.publish({
      type: 'message.completed',
      conversationId: this.deps.conversationId,
      messageId: stored.id,
      text,
      at: this.now(),
    })
  }

  private handleToolCall(data: Record<string, unknown>, time: number): void {
    const callId = asString(data.callId)
    const name = asString(data.name)
    if (callId === undefined || name === undefined) return
    if (this.calls.has(callId)) return

    const preview = sanitizeArgumentsPreview(data.arguments)
    const record: ToolCallRecord = {
      callId,
      tool: name,
      status: 'running',
      ...(preview === '' ? {} : { argumentsPreview: preview }),
    }
    const entry: CallRecord = { record, startedAt: time, ...(this.currentMessageId === undefined ? {} : { messageId: this.currentMessageId }) }
    this.calls.set(callId, entry)

    if (this.currentMessageId === undefined) {
      this.pending.push(record)
    } else {
      const list = this.attached.get(this.currentMessageId) ?? []
      list.push(record)
      this.attached.set(this.currentMessageId, list)
      this.deps.updateToolCalls(this.currentMessageId, list)
    }

    this.deps.publish({
      type: 'tool.started',
      conversationId: this.deps.conversationId,
      callId,
      tool: name,
      ...(preview === '' ? {} : { argumentsPreview: preview }),
      at: this.now(),
    })
  }

  private handleToolResult(data: Record<string, unknown>, time: number): void {
    const message = isRecord(data.message) ? data.message : {}
    const callId = asString(message.toolCallId) ?? asString(data.callId)
    if (callId === undefined) return
    const entry = this.calls.get(callId)
    const tool = entry?.record.tool ?? 'unknown'
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
        this.deps.updateToolCalls(entry.messageId, this.attached.get(entry.messageId) ?? [])
      }
    }

    // 结构化结果：业务工具通常把 JSON 写在 text 块里（例如 map_fly_to 的 flyTo 指令）。
    // 只解析单块、非错误、且不超过 4KB 的文本，避免把大结果塞进 SSE（review P1）。
    const textBlocks = (Array.isArray(message.content) ? message.content : [])
      .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => (block as { text: string }).text)
    const joined = textBlocks.join('\n').trim()
    const resultText = joined.length === 0 ? undefined : joined.length > 4096 ? `${joined.slice(0, 4096)}…` : joined
    let structured: unknown
    if (!isError && textBlocks.length === 1 && resultText !== undefined && resultText.length <= 4096) {
      const candidate = resultText.trim()
      if (candidate.startsWith('{') || candidate.startsWith('[')) {
        try {
          structured = JSON.parse(candidate)
        } catch {
          structured = undefined
        }
      }
    }

    this.deps.publish({
      type: 'tool.completed',
      conversationId: this.deps.conversationId,
      callId,
      tool,
      success: !isError,
      ...(errorText === undefined ? {} : { error: errorText }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(structured === undefined ? {} : { result: structured }),
      ...(resultText === undefined ? {} : { resultText }),
      at: this.now(),
    })
  }

  private handleTurnEnd(data: Record<string, unknown>): void {
    const reason = isRecord(data.reason) ? data.reason : undefined
    const kind = asString(reason?.kind)
    if (kind !== 'error') {
      // 正常完成等 idle；aborted/interrupted/max-tokens 仍以 idle 收尾（§6 只映射 error）。
      this.deps.logger.debug('turn ended without error', { sessionId: this.deps.sessionId, kind })
      return
    }
    const failure = isRecord(reason?.error) ? reason.error : undefined
    const message = asString(failure?.message) ?? '模型调用失败'
    this.finishFailed('TURN_ERROR', message)
  }

  private handleIdle(): void {
    if (this.terminal) return
    if (this.assistantTexts === 0) {
      this.finishFailed('TURN_EMPTY', '本轮没有产生任何助手文本')
      return
    }
    this.terminal = true
    this.deps.onTerminal('idle')
  }

  private finishFailed(code: string, message: string): void {
    if (this.terminal) return
    this.terminal = true
    this.failure = { code, message }
    this.deps.publish({
      type: 'message.failed',
      conversationId: this.deps.conversationId,
      message,
      code,
      at: this.now(),
    })
    this.deps.onTerminal('failed')
  }
}
