import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import type { AgentEvent } from '@agent-studio/shared'
import { createContext, createConfig } from '../helpers.js'
import { DshEventAdapter, sanitizeArgumentsPreview } from '../../src/runtime/DshEventAdapter.js'
import type { AppContext } from '../../src/context.js'
import type { GatewayDatabase } from '../../src/db/database.js'
import type { SessionRow } from '../../src/db/types.js'

let ctx: AppContext
let db: GatewayDatabase
let root: string
let session: SessionRow
let userId: string

beforeAll(() => {
  const created = createContext(createConfig())
  ctx = created.ctx
  db = created.db
  root = created.root
  userId = ctx.repos.users.findByUsername('admin')?.id ?? ''
  session = ctx.repos.sessions.create({
    id: 'session-adapter',
    userId,
    agentId: 'agent-adapter',
    agentVersion: 1,
    title: 'adapter test',
  })
})

afterAll(() => {
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function createAdapter(options: { maxTurns?: number; onMaxTurns?: () => void } = {}) {
  const events: AgentEvent[] = []
  const unsubscribe = ctx.hub.subscribe(session.id, (event) => events.push(event))
  const adapter = new DshEventAdapter({
    sessionId: session.id,
    userId,
    runtimeId: 'rt-adapter',
    agentId: session.agent_id,
    agentVersion: 1,
    dshSessionId: 'dsh-1',
    maxTurns: options.maxTurns ?? 20,
    hub: ctx.hub,
    sessions: ctx.repos.sessions,
    messages: ctx.repos.messages,
    logger: ctx.logger,
    toolLookup: { riskFor: () => 'medium' },
    ...(options.onMaxTurns === undefined ? {} : { onMaxTurns: options.onMaxTurns }),
  })
  adapter.beginRun()
  return { adapter, events, unsubscribe }
}

const statusNotification = (status: 'idle' | 'running') => ({
  method: 'session.status',
  params: { sessionId: 'dsh-1', status },
})

let seq = 1
function eventNotification(type: string, data: Record<string, unknown>, time: number) {
  return {
    method: 'session.event',
    params: {
      sessionId: 'dsh-1',
      event: { type, seq: (seq += 1), time, data },
    },
  }
}

const assistantMessage = (id: string, text: string, time = Date.now(), interrupted = false) =>
  eventNotification(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: { role: 'assistant', id, content: [{ type: 'text', text }] },
      stream: [],
      ...(interrupted ? { interrupted: true } : {}),
    },
    time,
  )

describe('DshEventAdapter 映射', () => {
  it('按真实事件结构映射并去重 assistant/message', () => {
    const { adapter, events, unsubscribe } = createAdapter()
    const now = 1_700_000_000_000

    adapter.handleNotification(statusNotification('running'))
    adapter.handleNotification(assistantMessage('m1', 'hello', now))
    // 同一 data.message.id 重复到达：不得产生第二条消息/第二个事件。
    adapter.handleNotification(assistantMessage('m1', 'hello', now))
    adapter.handleNotification(
      eventNotification(
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'query_station', arguments: '{"station":"A","apiKey":"secret-value"}' },
        now + 10,
      ),
    )
    adapter.handleNotification(
      eventNotification(
        'tool/call',
        { turn: 1, step: 1, callId: 'c1', name: 'query_station', arguments: '{"station":"A"}' },
        now + 11,
      ),
    )
    adapter.handleNotification(
      eventNotification(
        'tool/result',
        { turn: 1, step: 1, message: { toolCallId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] } },
        now + 35,
      ),
    )
    adapter.handleNotification(statusNotification('idle'))
    unsubscribe()

    expect(events.map((event) => event.type)).toEqual([
      'run.started',
      'message.delta',
      'tool.started',
      'tool.completed',
      'agent.completed',
    ])

    const delta = events.find((event) => event.type === 'message.delta')
    expect(delta).toMatchObject({ text: 'hello', mode: 'message', messageId: 'm1' })

    const started = events.find((event) => event.type === 'tool.started')
    expect(started).toMatchObject({ callId: 'c1', tool: 'query_station', risk: 'medium' })
    if (started?.type === 'tool.started') {
      expect(started.argumentsPreview).toContain('***')
      expect(started.argumentsPreview).not.toContain('secret-value')
    }

    const completed = events.find((event) => event.type === 'tool.completed')
    expect(completed).toMatchObject({ callId: 'c1', tool: 'query_station', success: true, durationMs: 25 })

    expect(events.at(-1)).toMatchObject({ type: 'agent.completed', text: 'hello', dshSessionId: 'dsh-1' })

    const messages = ctx.repos.messages.listBySession(session.id)
    expect(messages.filter((row) => row.role === 'assistant')).toHaveLength(1)
    const dto = ctx.repos.messages.toDto(messages[0]!)
    expect(dto.toolCalls?.[0]).toMatchObject({ callId: 'c1', tool: 'query_station', status: 'succeeded', durationMs: 25 })

    expect(ctx.repos.sessions.getById(session.id)?.status).toBe('idle')
  })

  it('assistant/message 的 interrupted 前缀不覆盖最终回答文本', () => {
    ctx.repos.sessions.updateStatus(session.id, 'idle')
    const { adapter, events, unsubscribe } = createAdapter()
    adapter.handleNotification(statusNotification('running'))
    adapter.handleNotification(assistantMessage('full', '完整回答', Date.now()))
    adapter.handleNotification(assistantMessage('partial', '半截', Date.now(), true))
    adapter.handleNotification(statusNotification('idle'))
    unsubscribe()
    expect(events.at(-1)).toMatchObject({ type: 'agent.completed', text: '完整回答' })
  })
})

describe('DshEventAdapter 终止态', () => {
  it('turn/end.error 映射为 agent.failed，之后 idle 不再发 completed', () => {
    ctx.repos.sessions.updateStatus(session.id, 'idle')
    const { adapter, events, unsubscribe } = createAdapter()
    adapter.handleNotification(statusNotification('running'))
    adapter.handleNotification(eventNotification('turn/start', { turn: 1 }, Date.now()))
    adapter.handleNotification(
      eventNotification(
        'turn/end',
        { turn: 1, reason: { kind: 'error', error: { message: '模型炸了', code: 'LLM_FAIL' } } },
        Date.now(),
      ),
    )
    const beforeIdle = events.length
    adapter.handleNotification(statusNotification('idle'))
    unsubscribe()

    const failed = events.find((event) => event.type === 'agent.failed')
    expect(failed).toMatchObject({ type: 'agent.failed', message: '模型炸了', code: 'LLM_FAIL' })
    expect(events.slice(beforeIdle).some((event) => event.type === 'agent.completed')).toBe(false)
    expect(events.filter((event) => event.type === 'agent.failed')).toHaveLength(1)
    expect(ctx.repos.sessions.getById(session.id)?.status).toBe('failed')
  })

  it('turn/end.interrupted 映射为 agent.failed', () => {
    ctx.repos.sessions.updateStatus(session.id, 'idle')
    const { adapter, events, unsubscribe } = createAdapter()
    adapter.handleNotification(statusNotification('running'))
    adapter.handleNotification(
      eventNotification('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, Date.now()),
    )
    unsubscribe()
    expect(events.at(-1)).toMatchObject({ type: 'agent.failed', code: 'interrupted' })
  })

  it('超过 maxTurns 只发出一个 run.limit 并回调关闭运行时', () => {
    ctx.repos.sessions.updateStatus(session.id, 'idle')
    const onMaxTurns = vi.fn()
    const { adapter, events, unsubscribe } = createAdapter({ maxTurns: 1, onMaxTurns })
    adapter.handleNotification(statusNotification('running'))
    adapter.handleNotification(eventNotification('turn/start', { turn: 1 }, Date.now()))
    adapter.handleNotification(eventNotification('turn/start', { turn: 2 }, Date.now()))
    adapter.handleNotification(statusNotification('idle'))
    unsubscribe()

    const terminals = events.filter((event) => event.type === 'run.limit' || event.type === 'agent.completed')
    expect(terminals).toHaveLength(1)
    expect(terminals[0]).toMatchObject({ type: 'run.limit', reason: 'max-turns' })
    expect(onMaxTurns).toHaveBeenCalledTimes(1)
    expect(adapter.getTurnCount()).toBe(2)
  })

  it('传输关闭映射为 agent.failed runtime-closed', () => {
    ctx.repos.sessions.updateStatus(session.id, 'idle')
    const { adapter, events, unsubscribe } = createAdapter()
    adapter.handleNotification(statusNotification('running'))
    adapter.handleTransportClosed(new Error('child exited with code 1'))
    unsubscribe()
    expect(events.at(-1)).toMatchObject({ type: 'agent.failed', code: 'runtime-closed' })
  })
})

describe('sanitizeArgumentsPreview', () => {
  it('脱敏敏感键并截断到 300 字符', () => {
    const preview = sanitizeArgumentsPreview('{"token":"abc","nested":{"password":"p","ok":"yes"}}')
    expect(preview).toContain('***')
    expect(preview).not.toContain('abc')
    expect(preview).not.toContain('"p"')
    expect(preview).toContain('yes')

    const long = sanitizeArgumentsPreview({ text: 'x'.repeat(1000) })
    expect(long.length).toBe(300)
  })

  it('非法 JSON 原样截断', () => {
    expect(sanitizeArgumentsPreview('{not json')).toBe('{not json')
    expect(sanitizeArgumentsPreview(undefined)).toBe('')
  })
})
