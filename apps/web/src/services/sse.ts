/**
 * SSE 解析。
 *
 * 浏览器 EventSource 不支持 POST，因此这里用 fetch + ReadableStream 手工解析
 * `event:` / `data:` 帧，逐条还原为共享契约里的 `AgentEvent`。
 */
import type { AgentEvent } from '@agent-studio/shared'

import { openEventStream } from './http'

export interface SseFrame {
  event: string
  data: string
}

/** 把字节流切成 SSE 帧，供单元级复用。 */
export async function* readSseFrames(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const rawFrame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const frame = parseFrame(rawFrame)
        if (frame !== null) yield frame
        boundary = buffer.indexOf('\n\n')
      }
    }
    buffer += decoder.decode()
    buffer = buffer.replace(/\r\n/g, '\n')
    const tail = parseFrame(buffer)
    if (tail !== null) yield tail
  } finally {
    // 提前结束（收到终态事件）时关闭底层连接，避免网关侧挂着一个读不完的响应。
    reader.cancel().catch(() => undefined)
  }
}

function parseFrame(rawFrame: string): SseFrame | null {
  const lines = rawFrame.split('\n')
  let event = 'message'
  const dataParts: string[] = []
  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') event = value
    else if (field === 'data') dataParts.push(value)
  }
  if (dataParts.length === 0) return null
  return { event, data: dataParts.join('\n') }
}

export interface StreamOptions {
  signal: AbortSignal
  onEvent: (event: AgentEvent) => void
}

/**
 * 发送一条用户消息并消费返回的事件流。
 * 正常结束（收到 agent.completed / agent.failed / 流关闭）时 resolve。
 */
export async function streamSessionEvents(
  sessionId: string,
  content: string,
  options: StreamOptions,
): Promise<void> {
  const response = await openEventStream(`/sessions/${encodeURIComponent(sessionId)}/messages`, { content }, {
    signal: options.signal,
  })
  const stream = response.body
  if (stream === null) return
  for await (const frame of readSseFrames(stream)) {
    if (frame.data === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.data)
    } catch {
      continue
    }
    if (!isAgentEvent(parsed)) continue
    options.onEvent(parsed)
    // 终态事件之后不会再有有效内容，主动收流，让调用方的 loading 立即结束。
    if (parsed.type === 'agent.completed' || parsed.type === 'agent.failed' || parsed.type === 'run.limit') {
      return
    }
  }
}

function isAgentEvent(value: unknown): value is AgentEvent {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { type?: unknown; sessionId?: unknown }
  return typeof candidate.type === 'string' && typeof candidate.sessionId === 'string'
}
