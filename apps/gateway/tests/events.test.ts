import { describe, expect, it } from 'vitest'
import type { MessageDto, ServiceEvent, ToolCallRecord } from '@agent-studio/shared'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import { silentLogger } from '../src/logger.js'
import { TurnEventAdapter, sanitizeArgumentsPreview } from '../src/runtime/TurnEventAdapter.js'

const SESSION = 'dsh-session-1'

function assistantNotification(
  messageId: string,
  content: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  sessionId = SESSION,
): HarnessNotification {
  return {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 1_000,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', id: messageId, content, source: { kind: 'model' } },
          ...extra,
        },
      },
    },
  }
}

function toolCallNotification(
  callId: string,
  name: string,
  args: string,
  sessionId = SESSION,
): HarnessNotification {
  return {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'tool/call',
        seq: 2,
        time: 1_500,
        data: { turn: 1, step: 1, callId, name, arguments: args },
      },
    },
  }
}

function toolResultNotification(
  callId: string,
  options: { isError?: boolean; error?: Record<string, unknown>; time?: number; sessionId?: string } = {},
): HarnessNotification {
  return {
    method: 'session.event',
    params: {
      sessionId: options.sessionId ?? SESSION,
      event: {
        type: 'tool/result',
        seq: 3,
        time: options.time ?? 1_750,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'tool',
            toolCallId: callId,
            content: [{ type: 'text', text: options.isError === true ? 'failed' : 'ok' }],
            ...(options.isError === true ? { isError: true } : {}),
          },
          ...(options.error === undefined ? {} : { error: options.error }),
        },
      },
    },
  }
}

function idleNotification(sessionId = SESSION): HarnessNotification {
  return { method: 'session.status', params: { sessionId, status: 'idle' } }
}

function turnErrorNotification(
  failure: { message: string; code: string } = { message: '模型限流', code: 'RATE_LIMIT' },
): HarnessNotification {
  return {
    method: 'session.event',
    params: {
      sessionId: SESSION,
      event: {
        type: 'turn/end',
        seq: 9,
        time: 2_000,
        data: { turn: 1, reason: { kind: 'error', error: failure } },
      },
    },
  }
}

function createAdapter() {
  const events: ServiceEvent[] = []
  const terminals: string[] = []
  const persisted: MessageDto[] = []
  const toolUpdates: Array<{ messageId: string; toolCalls: ToolCallRecord[] }> = []

  const adapter = new TurnEventAdapter({
    conversationId: 'conv-1',
    sessionId: SESSION,
    publish: (event) => events.push(event),
    persistAssistantMessage: ({ text, toolCalls }) => {
      const message: MessageDto = {
        id: `msg-${persisted.length + 1}`,
        conversationId: 'conv-1',
        role: 'assistant',
        content: text,
        sequence: persisted.length + 1,
        createdAt: 1_000,
        ...(toolCalls.length === 0 ? {} : { toolCalls: toolCalls.map((call) => ({ ...call })) }),
      }
      persisted.push(message)
      return message
    },
    updateToolCalls: (messageId, toolCalls) => {
      toolUpdates.push({ messageId, toolCalls: toolCalls.map((call) => ({ ...call })) })
    },
    onTerminal: (outcome) => terminals.push(outcome),
    logger: silentLogger,
    now: () => 5_000,
  })
  return { adapter, events, terminals, persisted, toolUpdates }
}

describe('runtime/TurnEventAdapter（真实 DSH payload → 5 个业务事件）', () => {
  it('assistant/message：只拼 text 块 → message.completed（不伪造 delta）', () => {
    const { adapter, events, persisted } = createAdapter()
    adapter.handleNotification(
      assistantNotification('asst-1', [
        { type: 'reasoning', text: '思考中' },
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
        { type: 'tool-call', id: 'call-1', name: 'search', arguments: '{}' },
      ]),
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'message.completed',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      text: '第一段第二段',
    })
    expect(persisted[0]?.content).toBe('第一段第二段')
    // 事件类型只能是 §6 那 5 个。
    expect(['message.completed']).toContain(events[0]?.type)
  })

  it('按 data.message.id 去重：同一消息重复通知只产生一条', () => {
    const { adapter, events, persisted } = createAdapter()
    const notification = assistantNotification('asst-1', [{ type: 'text', text: '回答' }])
    adapter.handleNotification(notification)
    adapter.handleNotification(notification)
    expect(events).toHaveLength(1)
    expect(persisted).toHaveLength(1)
  })

  it('tool/call → tool.started（参数脱敏）；tool/result → tool.completed（success + durationMs）', () => {
    const { adapter, events } = createAdapter()
    adapter.handleNotification(assistantNotification('asst-1', [{ type: 'text', text: '查一下' }]))
    adapter.handleNotification(
      toolCallNotification('call-1', 'search', JSON.stringify({ query: 'x', apiToken: 'secret-value' })),
    )
    adapter.handleNotification(toolResultNotification('call-1'))

    const started = events.find((event) => event.type === 'tool.started')
    expect(started).toMatchObject({ type: 'tool.started', callId: 'call-1', tool: 'search' })
    expect(started?.type === 'tool.started' ? started.argumentsPreview : '').not.toContain('secret-value')
    expect(started?.type === 'tool.started' ? started.argumentsPreview : '').toContain('***')

    const completed = events.find((event) => event.type === 'tool.completed')
    expect(completed).toMatchObject({
      type: 'tool.completed',
      callId: 'call-1',
      tool: 'search',
      success: true,
      durationMs: 250,
    })
  })

  it('tool/result 带 isError → success=false 并带 error 文案', () => {
    const { adapter, events } = createAdapter()
    adapter.handleNotification(toolCallNotification('call-9', 'fs-read', '{}'))
    adapter.handleNotification(
      toolResultNotification('call-9', {
        isError: true,
        error: { name: 'ToolError', code: 'DENIED', reason: 'not permitted' },
      }),
    )
    const completed = events.find((event) => event.type === 'tool.completed')
    expect(completed).toMatchObject({
      type: 'tool.completed',
      callId: 'call-9',
      success: false,
      error: 'not permitted',
    })
  })

  it('turn/end{reason.kind:error} → message.failed{TURN_ERROR} 且终止为 failed', () => {
    const { adapter, events, terminals } = createAdapter()
    adapter.handleNotification(turnErrorNotification())
    expect(events).toEqual([
      expect.objectContaining({
        type: 'message.failed',
        code: 'TURN_ERROR',
        message: '模型限流',
        conversationId: 'conv-1',
      }),
    ])
    expect(terminals).toEqual(['failed'])
    expect(adapter.lastFailure).toEqual({ code: 'TURN_ERROR', message: '模型限流' })
  })

  it('idle 且没有任何助手文本 → message.failed{TURN_EMPTY}', () => {
    const { adapter, events, terminals } = createAdapter()
    adapter.handleNotification(idleNotification())
    expect(events).toEqual([expect.objectContaining({ type: 'message.failed', code: 'TURN_EMPTY' })])
    expect(terminals).toEqual(['failed'])
  })

  it('idle 且有助手文本 → 正常终止（不再补事件）', () => {
    const { adapter, events, terminals } = createAdapter()
    adapter.handleNotification(assistantNotification('asst-1', [{ type: 'text', text: '完整回答' }]))
    adapter.handleNotification(idleNotification())
    expect(events.map((event) => event.type)).toEqual(['message.completed'])
    expect(terminals).toEqual(['idle'])
    // 终止后的重复通知不再产生事件。
    adapter.handleNotification(assistantNotification('asst-2', [{ type: 'text', text: '迟到' }]))
    expect(events).toHaveLength(1)
  })

  it('忽略其它 session 的通知', () => {
    const { adapter, events } = createAdapter()
    adapter.handleNotification(
      assistantNotification('asst-other', [{ type: 'text', text: '别人的' }], {}, 'dsh-other'),
    )
    adapter.handleNotification(idleNotification('dsh-other'))
    expect(events).toEqual([])
  })

  it('纯 tool-call 的 assistant/message（无文本）不产生 message.completed', () => {
    const { adapter, events } = createAdapter()
    adapter.handleNotification(
      assistantNotification('asst-tool', [{ type: 'tool-call', id: 'c1', name: 'x', arguments: '{}' }]),
    )
    expect(events).toEqual([])
  })

  it('工具调用挂到随后落库的助手消息上，并在结果返回后回写状态', () => {
    const { adapter, persisted, toolUpdates } = createAdapter()
    // 先有 tool/call（此时还没有助手文本消息）→ pending
    adapter.handleNotification(toolCallNotification('call-1', 'search', '{"q":1}'))
    adapter.handleNotification(assistantNotification('asst-1', [{ type: 'text', text: '结论' }]))
    expect(persisted[0]?.toolCalls?.[0]).toMatchObject({ callId: 'call-1', status: 'running' })

    adapter.handleNotification(toolResultNotification('call-1'))
    expect(toolUpdates.at(-1)).toMatchObject({
      messageId: 'msg-1',
      toolCalls: [expect.objectContaining({ callId: 'call-1', status: 'succeeded' })],
    })
  })

  it('fail()（传输关闭/超时）只发一次 message.failed', () => {
    const { adapter, events, terminals } = createAdapter()
    adapter.fail('RUNTIME_CLOSED', '运行时已关闭')
    adapter.fail('TIMEOUT', '又超时')
    expect(events).toEqual([expect.objectContaining({ type: 'message.failed', code: 'RUNTIME_CLOSED' })])
    expect(terminals).toEqual(['failed'])
  })

  it('sanitizeArgumentsPreview：非法 JSON 原样截断，长参数截到 300', () => {
    expect(sanitizeArgumentsPreview('{not json')).toBe('{not json')
    expect(sanitizeArgumentsPreview('x'.repeat(400))).toHaveLength(300)
    expect(sanitizeArgumentsPreview(undefined)).toBe('')
    expect(sanitizeArgumentsPreview('{"password":"p","safe":1}')).toBe('{"password":"***","safe":1}')
  })
})
