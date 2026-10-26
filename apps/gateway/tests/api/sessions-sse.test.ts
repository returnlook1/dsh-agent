import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentEvent } from '@agent-studio/shared'
import { auth, createHarness, login, type TestHarness } from '../helpers.js'
import type { RunService } from '../../src/services/RunService.js'

let h: TestHarness
let token: string
let sessionId: string

beforeAll(async () => {
  h = await createHarness()
  token = await login(h.app, 'admin', 'admin123')
  const userId = h.ctx.repos.users.findByUsername('admin')?.id ?? ''
  const session = h.ctx.repos.sessions.create({
    id: 'sse-session',
    userId,
    agentId: 'sse-agent',
    agentVersion: 1,
    title: 'sse test',
  })
  sessionId = session.id

  // 用假的 RunService 验证路由的 SSE 帧/终止行为（不启动真实 DSH）。
  const events: AgentEvent[] = [
    { type: 'run.started', sessionId, runId: 'run-1', at: Date.now() },
    {
      type: 'message.delta',
      sessionId,
      text: '完整一条',
      mode: 'message',
      messageId: 'm-1',
      at: Date.now(),
    },
    { type: 'agent.completed', sessionId, text: '完整一条', at: Date.now() },
  ]
  const fake = {
    start: () => {
      let resolveDone: (event: AgentEvent | undefined) => void = () => undefined
      const done = new Promise<AgentEvent | undefined>((resolve) => {
        resolveDone = resolve
      })
      return {
        open: (sink: (event: AgentEvent) => void) => {
          for (const event of events) sink(event)
          resolveDone(events.at(-1))
        },
        detach: () => undefined,
        done,
        terminal: () => events.at(-1),
      }
    },
  } as unknown as RunService
  h.ctx.services.runs = fake
})

afterAll(async () => {
  await h.close()
})

describe('POST /api/sessions/:id/messages（SSE）', () => {
  it('返回 text/event-stream，按 toSseFrame 输出并以唯一终止事件结束', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers: auth(token),
      payload: { content: 'hello' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.headers['cache-control']).toContain('no-cache')

    const body = response.body
    expect(body).toContain('event: run.started')
    expect(body).toContain('event: message.delta')
    expect(body).toContain('"mode":"message"')
    expect(body).toContain('event: agent.completed')
    // 只允许一个终止事件。
    expect(body.match(/event: agent\.completed/g)).toHaveLength(1)
    expect(body.match(/event: agent\.failed/g)).toBeNull()
    expect(body.endsWith('\n\n')).toBe(true)
  })

  it('未登录返回 401，非归属会话返回 404', async () => {
    const unauth = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      payload: { content: 'hello' },
    })
    expect(unauth.statusCode).toBe(401)

    const demoToken = await login(h.app, 'demo', 'demo123')
    const demo = await h.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/messages`,
      headers: auth(demoToken),
      payload: { content: 'hello' },
    })
    expect(demo.statusCode).toBe(404)
  })
})
