import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import { agentConfigSchema, type AgentEvent } from '@agent-studio/shared'
import { createContext, createConfig } from '../helpers.js'
import { RunService, type RunRuntimePort } from '../../src/services/RunService.js'
import type { AppContext } from '../../src/context.js'
import type { GatewayDatabase } from '../../src/db/database.js'
import type { SessionRow } from '../../src/db/types.js'
import { ApiError } from '../../src/http/errors.js'

let ctx: AppContext
let db: GatewayDatabase
let root: string
let userId: string
let agentCounter = 0

beforeAll(() => {
  const created = createContext(createConfig())
  ctx = created.ctx
  db = created.db
  root = created.root
  userId = ctx.repos.users.findByUsername('admin')?.id ?? ''
})

afterAll(() => {
  ctx.hub.shutdown()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

interface Fixture {
  session: SessionRow
  service: RunService
  runtime: { ensure: RunRuntimePort['ensure']; prompt: RunRuntimePort['prompt']; stopSession: RunRuntimePort['stopSession']; prompts: string[] }
}

function makeFixture(limits: { maxTurns?: number; maxConcurrentRuns?: number; maxRequestsPerHour?: number } = {}): Fixture {
  agentCounter += 1
  const agentId = `run-agent-${agentCounter}`
  const config = agentConfigSchema.parse({
    id: agentId,
    name: 'Run Agent',
    prompt: { system: 'you are a test agent' },
    limits,
  })
  const agent = ctx.repos.agents.insert({
    id: agentId,
    name: 'Run Agent',
    description: '',
    status: 'published',
    ownerId: userId,
    currentVersion: 1,
    draft: config,
  })
  expect(agent.status).toBe('published')
  ctx.repos.versions.insert({
    agentId,
    version: 1,
    config,
    createdBy: userId,
    verified: true,
    warnings: [],
  })
  ctx.repos.versions.replacePermissions(agentId, 1, {})

  const session = ctx.repos.sessions.create({
    id: `run-session-${agentCounter}`,
    userId,
    agentId,
    agentVersion: 1,
    title: '',
  })

  const prompts: string[] = []
  const runtime = {
    prompts,
    ensure: async () => ({ runtimeId: `rt-${agentCounter}`, dshSessionId: `dsh-${agentCounter}` }),
    prompt: async (_sessionId: string, text: string) => {
      prompts.push(text)
    },
    stopSession: async () => undefined,
  }

  const service = new RunService({
    sessions: ctx.repos.sessions,
    messages: ctx.repos.messages,
    versions: ctx.repos.versions,
    runtime,
    hub: ctx.hub,
    toolCatalog: ctx.toolCatalog,
    logger: ctx.logger,
  })
  return { session, service, runtime }
}

function collect(handle: ReturnType<RunService['start']>): AgentEvent[] {
  const events: AgentEvent[] = []
  handle.open((event) => events.push(event))
  return events
}

describe('RunService 事件流', () => {
  it('按序转发 run.started → message.delta → agent.completed，并只有一个终止事件', async () => {
    const { session, service, runtime } = makeFixture()
    runtime.prompt = async (_sessionId, text) => {
      runtime.prompts.push(text)
      ctx.hub.publish({
        type: 'run.started',
        sessionId: session.id,
        runId: 'run-1',
        at: Date.now(),
      })
      ctx.hub.publish({
        type: 'message.delta',
        sessionId: session.id,
        text: '你好',
        mode: 'message',
        messageId: 'msg-1',
        at: Date.now(),
      })
      ctx.hub.publish({
        type: 'agent.completed',
        sessionId: session.id,
        text: '你好',
        at: Date.now(),
      })
      // 终止后的重复终止事件必须被丢弃。
      ctx.hub.publish({
        type: 'agent.failed',
        sessionId: session.id,
        message: 'should not appear',
        at: Date.now(),
      })
    }

    const handle = service.start({ session, user: ctx.repos.users.toDto(ctx.repos.users.findByUsername('admin')!), content: '介绍一下自己' })
    const events = collect(handle)
    const terminal = await handle.done

    expect(events.map((event) => event.type)).toEqual(['run.started', 'message.delta', 'agent.completed'])
    expect(terminal).toMatchObject({ type: 'agent.completed', text: '你好' })
    expect(runtime.prompts).toEqual(['介绍一下自己'])

    // 用户消息已落库，标题按首条消息生成。
    const messages = ctx.repos.messages.listBySession(session.id)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', content: '介绍一下自己', sequence: 1 })
    expect(ctx.repos.sessions.getById(session.id)?.title).toBe('介绍一下自己')
    expect(ctx.repos.sessions.getById(session.id)?.status).toBe('idle')
    expect(ctx.hub.listenerCount(session.id)).toBe(0)
  })

  it('运行时失败时先写 agent.failed 再结束，HTTP 层无需再伪造终止事件', async () => {
    const { session, service } = makeFixture()
    // 默认 fake runtime.prompt 不产生事件；让 ensure 成功但 prompt 抛错。
    const failingService = new RunService({
      sessions: ctx.repos.sessions,
      messages: ctx.repos.messages,
      versions: ctx.repos.versions,
      runtime: {
        ensure: async () => ({ runtimeId: 'rt-fail', dshSessionId: 'dsh-fail' }),
        prompt: async () => {
          throw new Error('prompt rejected: transport closed')
        },
        stopSession: async () => undefined,
      },
      hub: ctx.hub,
      toolCatalog: ctx.toolCatalog,
      logger: ctx.logger,
    })

    const handle = failingService.start({
      session,
      user: ctx.repos.users.toDto(ctx.repos.users.findByUsername('admin')!),
      content: 'trigger failure',
    })
    const events = collect(handle)
    const terminal = await handle.done

    expect(terminal).toMatchObject({ type: 'agent.failed' })
    expect(events.filter((event) => event.type === 'agent.failed')).toHaveLength(1)
    expect(ctx.repos.sessions.getById(session.id)?.status).toBe('failed')
    void service
  })
})

describe('RunService 前置校验', () => {
  it('每小时请求数超限返回 429 RATE_LIMITED', () => {
    const { session, service } = makeFixture({ maxRequestsPerHour: 1 })
    ctx.repos.messages.append({ sessionId: session.id, role: 'user', content: 'earlier message' })

    try {
      service.start({
        session,
        user: ctx.repos.users.toDto(ctx.repos.users.findByUsername('admin')!),
        content: 'next message',
      })
      throw new Error('expected rate limit error')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).code).toBe('RATE_LIMITED')
      expect((error as ApiError).statusCode).toBe(429)
    }
  })

  it('会话非 idle 返回 409 CONFLICT', () => {
    const { session, service } = makeFixture()
    ctx.repos.sessions.updateStatus(session.id, 'running')
    try {
      service.start({
        session: { ...session, status: 'running' },
        user: ctx.repos.users.toDto(ctx.repos.users.findByUsername('admin')!),
        content: 'hello',
      })
      throw new Error('expected conflict error')
    } catch (error) {
      expect((error as ApiError).code).toBe('CONFLICT')
    }
  })

  it('并发运行数超限返回 409 CONFLICT', () => {
    const { session, service } = makeFixture({ maxConcurrentRuns: 1 })
    // 同一 (user, agent) 已有另一个 running 会话。
    const other = ctx.repos.sessions.create({
      id: 'run-session-concurrent',
      userId,
      agentId: session.agent_id,
      agentVersion: 1,
      title: 'other',
    })
    ctx.repos.sessions.updateStatus(other.id, 'running')

    try {
      service.start({
        session,
        user: ctx.repos.users.toDto(ctx.repos.users.findByUsername('admin')!),
        content: 'hello',
      })
      throw new Error('expected conflict error')
    } catch (error) {
      expect((error as ApiError).code).toBe('CONFLICT')
    }
  })
})
