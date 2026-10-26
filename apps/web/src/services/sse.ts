/**
 * SSE 解析（服务端业务事件流）。
 *
 * 浏览器 `EventSource` 只支持 GET，而发送消息是
 * `POST /api/conversations/:id/messages`，所以这里用 fetch + ReadableStream
 * 手工解析 SSE 帧。
 *
 * 前端只认识 `@agent-studio/shared` 里的 5 个 `ServiceEvent`：
 * 不解析 DSH 原始通知，也不做 token 级打字机（后端没有 delta 事件）。
 */
import type { ServiceEvent } from '@agent-studio/shared'

/** 一个完整的 SSE 帧。 */
export interface SseFrame {
  /** `event:` 字段；缺省为 `message`。 */
  event: string
  /** 多行 `data:` 以 `\n` 连接后的载荷。 */
  data: string
}

export interface SseParser {
  /** 喂入一段文本，返回本次可以完整消费的帧。 */
  push(chunk: string): SseFrame[]
  /** 流结束时冲刷残余行与未交付的帧。 */
  flush(): SseFrame[]
}

/**
 * 增量 SSE 解析器（纯函数式，无 DOM / 无网络依赖，可单测）。
 *
 * 支持的边界情况：
 * - 帧 / 行 / CRLF 被任意切分到多个 chunk；
 * - `\r\n`、`\n`、`\r` 三种行尾；
 * - `: ping` 注释行（保活帧）；
 * - 多行 `data:` 拼接；
 * - 流结束时有残留行或未以空行收尾的帧。
 */
export function createSseParser(): SseParser {
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let pending: SseFrame[] = []

  function handleLine(line: string): void {
    // 空行 = 帧结束。
    if (line.length === 0) {
      if (dataLines.length > 0) {
        pending.push({ event: eventName.length > 0 ? eventName : 'message', data: dataLines.join('\n') })
      }
      eventName = ''
      dataLines = []
      return
    }
    // 注释行（`: ping`），忽略。
    if (line.startsWith(':')) return

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') eventName = value
    else if (field === 'data') dataLines.push(value)
  }

  function drain(): SseFrame[] {
    for (;;) {
      const cr = buffer.indexOf('\r')
      const lf = buffer.indexOf('\n')
      let end = -1
      let width = 1

      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // 落在缓冲末位的 CR 可能是被切开的 CRLF，等下一段再判断。
        if (cr === buffer.length - 1) break
        end = cr
        width = buffer.charAt(cr + 1) === '\n' ? 2 : 1
      } else if (lf !== -1) {
        end = lf
        width = 1
      } else {
        break
      }

      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + width)
      handleLine(line)
    }

    const frames = pending
    pending = []
    return frames
  }

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk
      return drain()
    },

    flush(): SseFrame[] {
      const frames = drain()
      if (buffer.length > 0) {
        const rest = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
        buffer = ''
        if (rest.length > 0) handleLine(rest)
        else handleLine('')
      }
      if (dataLines.length > 0) {
        pending.push({ event: eventName.length > 0 ? eventName : 'message', data: dataLines.join('\n') })
        eventName = ''
        dataLines = []
      }
      frames.push(...pending)
      pending = []
      return frames
    },
  }
}

/* --------------------------------------------------------------- JSON 窄化 */

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' ? value : null
}

function readNumber(record: JsonRecord, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOptionalString(record: JsonRecord, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function readOptionalNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

/**
 * 把 JSON 载荷窄化为业务事件；非本协议的帧返回 null（忽略，不抛错）。
 * `event:` 名可能与 payload 不一致，以 payload 的 `type` 为准。
 */
export function toServiceEvent(value: unknown): ServiceEvent | null {
  if (!isRecord(value)) return null
  const type = value['type']
  const conversationId = readString(value, 'conversationId')
  const at = readNumber(value, 'at')
  if (conversationId === null || at === null) return null

  switch (type) {
    case 'message.started': {
      const messageId = readString(value, 'messageId')
      const role = value['role']
      if (messageId === null || (role !== 'user' && role !== 'assistant')) return null
      return { type, conversationId, at, messageId, role }
    }
    case 'message.completed': {
      const messageId = readString(value, 'messageId')
      const text = readString(value, 'text')
      if (messageId === null || text === null) return null
      return { type, conversationId, at, messageId, text }
    }
    case 'tool.started': {
      const callId = readString(value, 'callId')
      const tool = readString(value, 'tool')
      if (callId === null || tool === null) return null
      return {
        type,
        conversationId,
        at,
        callId,
        tool,
        argumentsPreview: readOptionalString(value, 'argumentsPreview'),
      }
    }
    case 'tool.completed': {
      const callId = readString(value, 'callId')
      const tool = readString(value, 'tool')
      const success = value['success']
      if (callId === null || tool === null || typeof success !== 'boolean') return null
      return {
        type,
        conversationId,
        at,
        callId,
        tool,
        success,
        error: readOptionalString(value, 'error'),
        durationMs: readOptionalNumber(value, 'durationMs'),
        // 未知 JSON 原样透传为 unknown（不在解析层扩散 any）；字段存在即保留，
        // 包括合法的 `null`。只有 `resultText` 才要求是字符串。
        ...(hasOwn(value, 'result') ? { result: value['result'] as unknown } : {}),
        ...(readOptionalString(value, 'resultText') === undefined
          ? {}
          : { resultText: readOptionalString(value, 'resultText') as string }),
      }
    }
    case 'message.failed': {
      const message = readString(value, 'message')
      if (message === null) return null
      return { type, conversationId, at, message, code: readOptionalString(value, 'code') }
    }
    default:
      return null
  }
}

/** 解析一个 SSE 帧；不是合法业务事件时返回 null。 */
export function parseServiceEventFrame(frame: SseFrame): ServiceEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(frame.data)
  } catch {
    return null
  }
  return toServiceEvent(parsed)
}

/** 终止事件：收到后不再读取后续帧（服务端也会同时关闭响应）。 */
export function isTerminalServiceEvent(event: ServiceEvent): boolean {
  return event.type === 'message.failed'
}

/**
 * 消费一个 SSE 响应体，按到达顺序回调业务事件。
 *
 * - 收到 `message.failed` 立即停止读取并取消底层流；
 * - 非法 / 无关帧被忽略；
 * - 流被 AbortController 取消时，底层 `read()` 抛 AbortError，原样上抛给调用方。
 */
export async function readServiceEventStream(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: ServiceEvent) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  const parser = createSseParser()

  const dispatch = (frames: readonly SseFrame[]): boolean => {
    for (const frame of frames) {
      const event = parseServiceEventFrame(frame)
      if (event === null) continue
      onEvent(event)
      if (isTerminalServiceEvent(event)) return true
    }
    return false
  }

  try {
    for (;;) {
      const result = await reader.read()
      if (result.done) break
      if (result.value === undefined) continue
      const frames = parser.push(decoder.decode(result.value, { stream: true }))
      if (dispatch(frames)) return
    }
    dispatch(parser.push(decoder.decode()))
    dispatch(parser.flush())
  } finally {
    // 提前终止（终态事件）时关闭连接；正常读完时是 no-op。
    try {
      await reader.cancel()
    } catch {
      // 连接已断开，忽略。
    }
  }
}
