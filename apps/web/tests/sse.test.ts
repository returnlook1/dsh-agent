/**
 * SSE 解析单测：不依赖浏览器，用 Node 的 ReadableStream 模拟分块响应。
 *
 * 覆盖需求点：分块帧、CRLF、注释行（`: ping`）、多行 `data:`、
 * `message.failed` 提前终止（且底层流被取消）。
 */
import type { ServiceEvent } from '@agent-studio/shared'
import { describe, expect, it } from 'vitest'

import {
  createSseParser,
  parseServiceEventFrame,
  readServiceEventStream,
  toServiceEvent,
} from '../src/services/sse'

const encoder = new TextEncoder()

function streamOf(chunks: readonly string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
    cancel() {
      onCancel?.()
    },
  })
}

async function collect(chunks: readonly string[], onCancel?: () => void): Promise<ServiceEvent[]> {
  const events: ServiceEvent[] = []
  await readServiceEventStream(streamOf(chunks, onCancel), (event) => {
    events.push(event)
  })
  return events
}

function frameOf(event: ServiceEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

const userStarted: ServiceEvent = {
  type: 'message.started',
  conversationId: 'c1',
  at: 1,
  messageId: 'm-user',
  role: 'user',
}

const completed: ServiceEvent = {
  type: 'message.completed',
  conversationId: 'c1',
  at: 2,
  messageId: 'm-assistant',
  text: '你好，这是完整的助手消息。',
}

const failed: ServiceEvent = {
  type: 'message.failed',
  conversationId: 'c1',
  at: 3,
  message: '模型请求失败',
  code: 'TURN_ERROR',
}

describe('createSseParser', () => {
  it('按任意分块边界切分 event/data 帧时仍能还原', async () => {
    const chunks = [
      'event: message.started\ndata: {"type":"message.started","convers',
      'ationId":"c1","messageId":"m-user","role":"user","at":1}\n',
      '\n',
    ]
    const events = await collect(chunks)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message.started', messageId: 'm-user', role: 'user' })
  })

  it('支持 CRLF，并忽略 `: ping` 注释行', async () => {
    const raw =
      ': ping\r\n\r\n' +
      'event: message.completed\r\n' +
      'data: {"type":"message.completed","conversationId":"c1","messageId":"m-assistant","text":"ok","at":2}\r\n' +
      '\r\n' +
      ': ping\r\n\r\n'
    const events = await collect([raw])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message.completed', text: 'ok' })
  })

  it('CRLF 被切分到两个 chunk 时不会丢帧', () => {
    const parser = createSseParser()
    expect(parser.push('data: hello\r')).toEqual([])
    expect(parser.push('\n\r\n')).toEqual([{ event: 'message', data: 'hello' }])
  })

  it('多行 data: 以换行拼接，可承载分行书写的 JSON', async () => {
    const chunks = [
      'event: message.completed\n',
      'data: {"type":"message.completed",\n',
      'data: "conversationId":"c1","messageId":"m-multi",\n',
      'data: "text":"多行","at":7}\n\n',
    ]
    const events = await collect(chunks)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'message.completed', messageId: 'm-multi', text: '多行', at: 7 })
  })

  it('流结束时冲刷未以空行收尾的残留帧', () => {
    const parser = createSseParser()
    parser.push('event: message.completed\ndata: {"type":"message.completed"}')
    const frames = parser.flush()
    expect(frames).toEqual([
      { event: 'message.completed', data: '{"type":"message.completed"}' },
    ])
  })
})

describe('readServiceEventStream', () => {
  it('按顺序分发多个事件', async () => {
    const events = await collect([frameOf(userStarted) + frameOf(completed)])
    expect(events.map((event) => event.type)).toEqual(['message.started', 'message.completed'])
  })

  it('收到 message.failed 后停止读取，并取消底层流', async () => {
    let cancelled = false
    let pulls = 0
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frameOf(completed)))
        controller.enqueue(encoder.encode(frameOf(failed)))
        controller.enqueue(
          encoder.encode(
            frameOf({
              type: 'message.completed',
              conversationId: 'c1',
              at: 4,
              messageId: 'm-after-failed',
              text: '不应到达',
            }),
          ),
        )
        // 故意不 close：如果实现继续 read，测试会超时。
      },
      pull() {
        pulls += 1
      },
      cancel() {
        cancelled = true
      },
    })

    const events: ServiceEvent[] = []
    await readServiceEventStream(stream, (event) => {
      events.push(event)
    })

    expect(events.map((event) => event.type)).toEqual(['message.completed', 'message.failed'])
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(3)
  })

  it('忽略非 JSON / 非业务事件的帧', async () => {
    const events = await collect([
      'data: not-json\n\n',
      'data: {"type":"unknown.event","conversationId":"c1","at":1}\n\n',
      frameOf(userStarted),
    ])
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('message.started')
  })
})

describe('tool.completed 结果字段', () => {
  it('保留结构化 result 与文本 resultText', () => {
    const event = parseServiceEventFrame({
      event: 'tool.completed',
      data: JSON.stringify({
        type: 'tool.completed',
        conversationId: 'c1',
        at: 20,
        callId: 'call-map',
        tool: 'map_fly_to',
        success: true,
        durationMs: 21,
        result: { action: 'flyTo', longitude: 121.5, latitude: 31.2, zoom: 8 },
        resultText: '已定位到上海',
      }),
    })
    expect(event).toMatchObject({
      type: 'tool.completed',
      callId: 'call-map',
      success: true,
      result: { action: 'flyTo', longitude: 121.5, latitude: 31.2, zoom: 8 },
      resultText: '已定位到上海',
    })
  })

  it('不假设 result 的形状：数组 / null / 字符串原样透传', () => {
    for (const result of [[1, 2, 3], null, 'plain', 42]) {
      const event = toServiceEvent({
        type: 'tool.completed',
        conversationId: 'c1',
        at: 21,
        callId: 'call-x',
        tool: 't',
        success: true,
        result,
      })
      expect(event).toMatchObject({ result })
    }
  })

  it('resultText 不是字符串时丢弃该字段，而非丢弃整个事件', () => {
    const event = toServiceEvent({
      type: 'tool.completed',
      conversationId: 'c1',
      at: 22,
      callId: 'call-y',
      tool: 't',
      success: true,
      error: 123,
      durationMs: 'slow',
      resultText: { nested: true },
    })
    expect(event).not.toBeNull()
    expect(event).toMatchObject({ type: 'tool.completed', callId: 'call-y' })
    if (event === null || event.type !== 'tool.completed') throw new Error('事件窄化失败')
    expect(event.resultText).toBeUndefined()
    expect(event.error).toBeUndefined()
    expect(event.durationMs).toBeUndefined()
  })

  it('坏 JSON 帧不会抛错，流里后续合法事件仍被分发', async () => {
    const events = await collect([
      'event: tool.completed\n',
      'data: {"type":"tool.completed","conversationId":"c1",\n\n',
      frameOf({
        type: 'tool.completed',
        conversationId: 'c1',
        at: 23,
        callId: 'call-good',
        tool: 't',
        success: true,
        result: { ok: true },
      }),
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ callId: 'call-good', result: { ok: true } })
  })
})

describe('边界窄化', () => {
  it('缺少必填字段的事件返回 null', () => {
    expect(toServiceEvent({ type: 'message.completed', conversationId: 'c1', at: 1 })).toBeNull()
    expect(toServiceEvent({ type: 'message.started', conversationId: 'c1', at: 1, messageId: 'm', role: 'system' })).toBeNull()
    expect(toServiceEvent({ type: 'tool.completed', conversationId: 'c1', at: 1, callId: 'x', tool: 't', success: 'yes' })).toBeNull()
    expect(toServiceEvent(null)).toBeNull()
  })

  it('保留可选字段并丢弃未知字段', () => {
    const event = parseServiceEventFrame({
      event: 'tool.completed',
      data: JSON.stringify({
        type: 'tool.completed',
        conversationId: 'c1',
        at: 9,
        callId: 'call-1',
        tool: 'read_file',
        success: false,
        error: 'permission denied',
        durationMs: 12,
        extra: 'ignored',
      }),
    })
    expect(event).toEqual({
      type: 'tool.completed',
      conversationId: 'c1',
      at: 9,
      callId: 'call-1',
      tool: 'read_file',
      success: false,
      error: 'permission denied',
      durationMs: 12,
    })
  })
})
