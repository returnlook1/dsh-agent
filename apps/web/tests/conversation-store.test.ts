/**
 * 对话 store 的事件归并单测：验证"只依赖 5 个业务事件"的映射行为。
 *
 * 用 stub 的 fetch 返回一段 SSE 响应，不启动真实网关。
 */
import type { ConversationDto, MessageDto, ServiceEvent } from '@agent-studio/shared'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useConversationStore } from '../src/stores/conversation'

const encoder = new TextEncoder()

type Store = ReturnType<typeof useConversationStore>

let store: Store
let meta: ConversationDto

function conversationDto(overrides: Partial<ConversationDto> = {}): ConversationDto {
  return {
    id: 'conv-1',
    projectId: 'default',
    sessionId: 'sess-1',
    config: {
      skills: [],
      mcpServers: [],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      systemPrompt: '',
      configKey: 'key-1',
      projectId: 'default',
      createdAt: 1,
      inheritedFromProject: false,
    },
    status: 'idle',
    title: '',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  }
}

function sseStream(events: readonly ServiceEvent[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

function stubFetch(
  events: readonly ServiceEvent[],
  httpStatus = 200,
  history: readonly MessageDto[] = [],
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.endsWith('/messages')) {
        if (method === 'GET') {
          return new Response(JSON.stringify({ conversationId: 'conv-1', messages: history }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        if (httpStatus !== 200) {
          return new Response(
            JSON.stringify({ error: { code: 'CONVERSATION_RUNNING', message: '该对话正在运行' } }),
            { status: httpStatus, headers: { 'Content-Type': 'application/json' } },
          )
        }
        return new Response(sseStream(events), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }
      return new Response(JSON.stringify(meta), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
}

beforeEach(() => {
  setActivePinia(createPinia())
  meta = conversationDto()
  store = useConversationStore()
  store.current = meta
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const userStarted: ServiceEvent = {
  type: 'message.started',
  conversationId: 'conv-1',
  at: 10,
  messageId: 'msg-user',
  role: 'user',
}

function assistantCompleted(messageId: string, text: string, at: number): ServiceEvent {
  return { type: 'message.completed', conversationId: 'conv-1', at, messageId, text }
}

describe('conversation store · ServiceEvent 归并', () => {
  it('确认用户气泡、按 callId 归并工具卡片、追加助手消息', async () => {
    const events: ServiceEvent[] = [
      userStarted,
      { type: 'tool.started', conversationId: 'conv-1', at: 11, callId: 'call-1', tool: 'read_file', argumentsPreview: '{"path":"a.txt"}' },
      { type: 'tool.completed', conversationId: 'conv-1', at: 12, callId: 'call-1', tool: 'read_file', success: true, durationMs: 12 },
      assistantCompleted('msg-a1', '工具调用完成。', 13),
    ]
    stubFetch(events)

    const result = await store.send('你好')

    expect(result.ok).toBe(true)
    expect(store.streaming).toBe(false)
    expect(store.error).toBeNull()

    const user = store.messages.find((message) => message.role === 'user')
    expect(user?.id).toBe('msg-user')
    expect(user?.optimistic).toBe(false)
    expect(user?.content).toBe('你好')

    const assistants = store.messages.filter((message) => message.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.content).toBe('工具调用完成。')
    expect(assistants[0]?.toolCalls).toEqual([
      {
        callId: 'call-1',
        tool: 'read_file',
        argumentsPreview: '{"path":"a.txt"}',
        status: 'succeeded',
        error: undefined,
        durationMs: 12,
      },
    ])
  })

  it('同一 messageId 只追加一次，不同 messageId 按到达顺序累加', async () => {
    stubFetch([
      userStarted,
      assistantCompleted('msg-a1', '第一段', 11),
      assistantCompleted('msg-a1', '第一段', 12),
      { type: 'tool.started', conversationId: 'conv-1', at: 13, callId: 'call-2', tool: 'grep' },
      { type: 'tool.completed', conversationId: 'conv-1', at: 14, callId: 'call-2', tool: 'grep', success: false, error: 'not found' },
      assistantCompleted('msg-a2', '第二段', 15),
    ])

    await store.send('继续')

    const assistants = store.messages.filter((message) => message.role === 'assistant')
    expect(assistants.map((message) => message.id)).toEqual(['msg-a1', 'msg-a2'])
    expect(assistants[0]?.content).toBe('第一段')
    expect(assistants[0]?.toolCalls[0]).toMatchObject({ callId: 'call-2', status: 'failed', error: 'not found' })
    expect(assistants[1]?.content).toBe('第二段')
  })

  it('message.failed 写入可见错误并结束本轮', async () => {
    meta = conversationDto({ status: 'failed', lastError: '模型请求失败' })
    stubFetch([
      userStarted,
      { type: 'message.failed', conversationId: 'conv-1', at: 11, message: '模型请求失败', code: 'TURN_ERROR' },
    ])

    await store.send('会失败')

    expect(store.error).toBe('模型请求失败')
    expect(store.errorCode).toBe('TURN_ERROR')
    expect(store.streaming).toBe(false)
    await vi.waitFor(() => expect(store.current?.status).toBe('failed'))
  })

  it('进入流之前的 409 会回滚乐观气泡并提示运行中', async () => {
    stubFetch([], 409)

    const result = await store.send('重复发送')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('正在运行')
    expect(store.error).toContain('正在运行')
    expect(store.messages).toHaveLength(0)
    expect(store.streaming).toBe(false)
  })

  it('忽略 conversationId 不匹配的事件', async () => {
    stubFetch([
      userStarted,
      {
        type: 'message.completed',
        conversationId: 'other-conversation',
        at: 11,
        messageId: 'msg-other',
        text: '不应出现',
      },
      assistantCompleted('msg-a1', '正确消息', 12),
    ])

    await store.send('你好')

    expect(store.messages.filter((message) => message.role === 'assistant').map((message) => message.id)).toEqual([
      'msg-a1',
    ])
  })

  it('loadConversation 回放历史消息与工具调用', async () => {
    stubFetch([], 200, [
      {
        id: 'history-user',
        conversationId: 'conv-1',
        role: 'user',
        content: '历史提问',
        sequence: 1,
        createdAt: 1,
      },
      {
        id: 'history-assistant',
        conversationId: 'conv-1',
        role: 'assistant',
        content: '历史回答',
        sequence: 2,
        createdAt: 2,
        toolCalls: [
          { callId: 'history-call', tool: 'read_file', argumentsPreview: '{"path":"b"}', status: 'succeeded', durationMs: 9 },
        ],
      },
    ])

    await store.loadConversation('conv-1')

    expect(store.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(store.messages[1]?.content).toBe('历史回答')
    expect(store.messages[1]?.toolCalls[0]).toMatchObject({
      callId: 'history-call',
      status: 'succeeded',
      durationMs: 9,
    })
    expect(store.messagesLoading).toBe(false)
  })
})
