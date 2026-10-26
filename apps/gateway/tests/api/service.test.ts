import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { AgentConfigSnapshot, SkillCatalogResponse, MessageListResponse } from '@agent-studio/shared'
import {
  createFakeClientFactory,
  createHarness,
  defaultTurnScript,
  type FakeFactoryHandle,
  type TestHarness,
  type TurnScript,
} from '../helpers.js'

let h: TestHarness
let factory: FakeFactoryHandle
/** 可变的脚本开关：不同用例可以换行为，且只在新建运行时生效。 */
let script: TurnScript

const SKILLS = [
  { name: 'netcdf-analysis', description: '分析 NetCDF 文件', whenToUse: '读取 .nc 时', bundle: true },
  { name: 'gis-processing', description: '处理 GIS 图层', bundle: false },
]

const MCP_SERVERS = [
  {
    id: 'data-center',
    name: '数据中心',
    description: '查询数据集目录',
    transport: 'stdio',
    command: 'node',
    args: ['${REPO_ROOT}/scripts/mcp-data-center-server.mjs'],
    enabled: true,
  },
  { id: 'gis-service', name: 'GIS 服务', transport: 'streamable-http', url: 'http://127.0.0.1:9100/mcp', enabled: false },
]

const toolTurnScript: TurnScript = ({ sessionId }) => [
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'assistant/message',
        seq: 1,
        time: 1,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            id: 'asst-tool',
            content: [{ type: 'text', text: '我查一下。' }],
            source: { kind: 'model' },
          },
        },
      },
    },
  },
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'tool/call',
        seq: 2,
        time: 2,
        data: { turn: 1, step: 1, callId: 'call-1', name: 'mcp__data-center__search_dataset', arguments: '{"q":"x"}' },
      },
    },
  },
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'tool/result',
        seq: 3,
        time: 12,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] },
        },
      },
    },
  },
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'assistant/message',
        seq: 4,
        time: 20,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            id: 'asst-final',
            content: [{ type: 'text', text: '查询完成。' }],
            source: { kind: 'model' },
          },
        },
      },
    },
  },
  { method: 'session.status', params: { sessionId, status: 'idle' } } as HarnessNotification,
]

const errorTurnScript: TurnScript = ({ sessionId }) => [
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'turn/end',
        seq: 2,
        time: 5,
        data: { turn: 1, reason: { kind: 'error', error: { message: '模型限流', code: 'RATE_LIMIT' } } },
      },
    },
  },
  { method: 'session.status', params: { sessionId, status: 'idle' } },
]

interface CreatedConversation {
  conversationId: string
  sessionId: string
  config: AgentConfigSnapshot
}

async function createConversation(body: Record<string, unknown> = {}): Promise<CreatedConversation> {
  const response = await h.app.inject({
    method: 'POST',
    url: '/api/conversations',
    payload: { projectId: 'ocean-project', ...body },
  })
  expect(response.statusCode).toBe(201)
  return response.json() as CreatedConversation
}

beforeAll(async () => {
  script = defaultTurnScript
  factory = createFakeClientFactory((context) => script(context))
  h = await createHarness({ skills: SKILLS, mcpServers: MCP_SERVERS, clientFactory: factory.factory })
})

afterAll(async () => {
  await h.close()
})

describe('API：能力清单与健康检查', () => {
  it('GET /api/health 返回版本、DSH 版本、运行时数量与 uptime', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      version: '2.0.0',
      runtimes: expect.any(Number),
      uptimeSec: expect.any(Number),
    })
    expect(String(body.dshVersion)).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('GET /api/skills 列出技能与扫描根目录', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/skills' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as SkillCatalogResponse
    expect(body.skills.map((skill) => skill.name).sort()).toEqual(['gis-processing', 'netcdf-analysis'])
    expect(body.skills[0]?.source).toBe('project')
    expect(body.roots).toEqual([{ path: h.skillsDir, source: 'project' }])
  })

  it('GET /api/mcp-servers 列出服务器（含 enabled）与配置文件路径', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/mcp-servers' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { servers: Array<Record<string, unknown>>; configPath: string }
    expect(body.configPath).toBe(h.mcpConfigPath)
    expect(body.servers.map((server) => [server.id, server.enabled])).toEqual([
      ['data-center', true],
      ['gis-service', false],
    ])
  })
})

describe('API：项目配置', () => {
  it('GET /api/projects/:id/agent-config 未保存时返回默认值 + saved:false', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/projects/fresh-project/agent-config' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      projectId: 'fresh-project',
      saved: false,
      skills: [],
      mcpServers: [],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      systemPrompt: '',
    })
  })

  it('PUT 保存项目配置（patch），GET 能读回并带 saved:true/updatedAt', async () => {
    const put = await h.app.inject({
      method: 'PUT',
      url: '/api/projects/ocean-project/agent-config',
      // model 由 DSH 统一管理：这里传了也会被忽略，保存的是 DSH 的默认路由
      payload: { skills: ['netcdf-analysis'], model: 'deepseek-v4-pro' },
    })
    expect(put.statusCode).toBe(200)
    const saved = put.json() as Record<string, unknown>
    expect(saved).toMatchObject({ projectId: 'ocean-project', saved: true, model: 'deepseek-flash' })
    expect(saved.updatedAt).toEqual(expect.any(Number))

    const get = await h.app.inject({ method: 'GET', url: '/api/projects/ocean-project/agent-config' })
    expect(get.json()).toMatchObject({ saved: true, skills: ['netcdf-analysis'] })
  })

  it('PUT 项目配置引用未知技能 → 400 SKILL_UNKNOWN（附 available）', async () => {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/api/projects/ocean-project/agent-config',
      payload: { skills: ['missing-skill'] },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json() as { error: { code: string; details?: { available?: string[] } } }
    expect(body.error.code).toBe('SKILL_UNKNOWN')
    expect(body.error.details?.available?.sort()).toEqual(['gis-processing', 'netcdf-analysis'])
  })

  it('PUT 项目配置引用未知 MCP 服务器 → 400 MCP_UNKNOWN（附 available）', async () => {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/api/projects/ocean-project/agent-config',
      payload: { mcpServers: ['nope'] },
    })
    expect(response.statusCode).toBe(400)
    const body = response.json() as { error: { code: string; details?: { available?: string[] } } }
    expect(body.error.code).toBe('MCP_UNKNOWN')
    expect(body.error.details?.available).toEqual(['data-center'])
  })
})

describe('API：对话创建与配置快照', () => {
  it('POST /api/conversations 不带 skills 时继承项目配置 → 201 + 快照', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'ocean-project' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as {
      conversationId: string
      sessionId: string
      config: Record<string, unknown> & { configKey: string; skills: string[]; inheritedFromProject: boolean }
    }
    expect(body.conversationId).toMatch(/^conv-/)
    expect(body.sessionId).toMatch(/^dsh-/)
    expect(body.config.inheritedFromProject).toBe(true)
    expect(body.config.skills).toEqual(['netcdf-analysis'])
    expect(body.config.configKey).toMatch(/^[0-9a-f]{16}$/)
  })

  it('POST /api/conversations 带 skills/mcpServers 时与项目配置取并集', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'ocean-project', skills: ['gis-processing'], mcpServers: ['data-center'] },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { config: { skills: string[]; mcpServers: string[] } }
    expect(body.config.skills.sort()).toEqual(['gis-processing', 'netcdf-analysis'])
    expect(body.config.mcpServers).toEqual(['data-center'])
  })

  it('inheritProjectConfig:false 时不看项目配置', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'ocean-project', skills: ['gis-processing'], inheritProjectConfig: false },
    })
    const body = response.json() as { config: { skills: string[]; inheritedFromProject: boolean } }
    expect(body.config.skills).toEqual(['gis-processing'])
    expect(body.config.inheritedFromProject).toBe(false)
  })

  it('POST 引用未知技能/服务器 → 400 SKILL_UNKNOWN / MCP_UNKNOWN', async () => {
    const skills = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'p1', skills: ['nope'], inheritProjectConfig: false },
    })
    expect(skills.statusCode).toBe(400)
    expect((skills.json() as { error: { code: string } }).error.code).toBe('SKILL_UNKNOWN')

    const mcp = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'p1', mcpServers: ['nope'], inheritProjectConfig: false },
    })
    expect(mcp.statusCode).toBe(400)
    expect((mcp.json() as { error: { code: string } }).error.code).toBe('MCP_UNKNOWN')
  })

  it('缺少 projectId → 400 VALIDATION_ERROR', async () => {
    const response = await h.app.inject({ method: 'POST', url: '/api/conversations', payload: {} })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('GET /api/conversations 支持 projectId 过滤与 limit；GET /:id 返回详情', async () => {
    const list = await h.app.inject({ method: 'GET', url: '/api/conversations?projectId=ocean-project&limit=2' })
    expect(list.statusCode).toBe(200)
    const body = list.json() as { conversations: Array<{ id: string; messageCount: number }> }
    expect(body.conversations.length).toBeGreaterThan(0)
    expect(body.conversations.length).toBeLessThanOrEqual(2)

    const id = body.conversations[0]?.id as string
    const detail = await h.app.inject({ method: 'GET', url: `/api/conversations/${id}` })
    expect(detail.statusCode).toBe(200)
    expect(detail.json()).toMatchObject({ id, status: 'idle', messageCount: 0 })
  })

  it('GET /api/conversations/:id/config 返回冻结快照；未知 id → 404', async () => {
    const created = await createConversation()
    const response = await h.app.inject({
      method: 'GET',
      url: `/api/conversations/${created.conversationId}/config`,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      projectId: 'ocean-project',
      configKey: expect.stringMatching(/^[0-9a-f]{16}$/),
      createdAt: expect.any(Number),
    })

    const missing = await h.app.inject({ method: 'GET', url: '/api/conversations/conv-missing' })
    expect(missing.statusCode).toBe(404)
    expect((missing.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })
})

describe('API：对话配置修改', () => {
  it('0 条消息时 PUT 配置 → 200 返回新快照（新 configKey）', async () => {
    const created = await createConversation({ inheritProjectConfig: false, skills: ['gis-processing'] })
    const before = created.config.configKey

    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/conversations/${created.conversationId}/config`,
      payload: { skills: ['netcdf-analysis'], systemPrompt: '只回答海洋问题' },
    })
    expect(response.statusCode).toBe(200)
    const snapshot = response.json() as {
      configKey: string
      projectId: string
      createdAt: number
      inheritedFromProject: boolean
      skills: string[]
      systemPrompt: string
    }
    expect(snapshot.configKey).not.toBe(before)
    expect(snapshot).toMatchObject({
      projectId: 'ocean-project',
      skills: ['netcdf-analysis'],
      systemPrompt: '只回答海洋问题',
      inheritedFromProject: false,
    })
    expect(snapshot.createdAt).toEqual(expect.any(Number))
  })

  it('PUT 配置引用未知技能 → 400 SKILL_UNKNOWN', async () => {
    const created = await createConversation()
    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/conversations/${created.conversationId}/config`,
      payload: { skills: ['ghost'] },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('SKILL_UNKNOWN')
  })

  it('已有消息后 PUT 配置 → 409 CONVERSATION_STARTED', async () => {
    const created = await createConversation()
    const conversationId = created.conversationId
    h.ctx.conversations.beginTurn(conversationId, '第一条消息')
    h.ctx.conversations.markIdle(conversationId)

    const response = await h.app.inject({
      method: 'PUT',
      url: `/api/conversations/${conversationId}/config`,
      payload: { model: 'deepseek-v4-pro' },
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: { code: string } }).error.code).toBe('CONVERSATION_STARTED')
  })
})

describe('API：消息历史', () => {
  it('新对话的消息列表为空；落库后按 sequence 返回', async () => {
    const created = await createConversation()
    const conversationId = created.conversationId

    const empty = await h.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` })
    expect(empty.statusCode).toBe(200)
    expect(empty.json()).toEqual({ conversationId, messages: [] })

    h.ctx.conversations.beginTurn(conversationId, '你好')
    h.ctx.conversations.appendAssistant(conversationId, { text: '你好，我是助手', toolCalls: [] })

    const list = await h.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` })
    const body = list.json() as MessageListResponse
    expect(body.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
    expect(body.messages.map((message) => message.sequence)).toEqual([1, 2])
    expect(body.messages[1]).toMatchObject({ content: '你好，我是助手' })
  })
})

describe('API：SSE 发送消息', () => {
  it('正常一轮：SSE 帧 message.started → message.completed，流以 idle 收尾', async () => {
    script = defaultTurnScript
    const created = await createConversation({ inheritProjectConfig: false })
    const conversationId = created.conversationId

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: '你好' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/event-stream')
    expect(response.headers['cache-control']).toContain('no-cache')
    expect(response.headers['cache-control']).toContain('no-transform')
    expect(response.headers['x-accel-buffering']).toBe('no')

    const body = response.body
    expect(body).toContain('event: message.started')
    expect(body).toContain('"role":"user"')
    expect(body).toContain('event: message.completed')
    expect(body).toContain('第 1 轮回答')
    expect(body).not.toContain('event: message.failed')

    // 状态回到 idle，消息已落库。
    const detail = await h.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })
    expect(detail.json()).toMatchObject({ status: 'idle', messageCount: 2, title: '你好' })

    const messages = await h.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` })
    const body2 = messages.json() as MessageListResponse
    expect(body2.messages.map((message) => message.role)).toEqual(['user', 'assistant'])
  })

  it('工具调用轮：SSE 含 tool.started/tool.completed，历史里带 toolCalls', async () => {
    script = toolTurnScript
    const created = await createConversation({ inheritProjectConfig: false, systemPrompt: '工具轮' })
    const conversationId = created.conversationId

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: '查一下数据' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('event: message.completed')
    expect(response.body).toContain('event: tool.started')
    expect(response.body).toContain('event: tool.completed')
    expect(response.body).toContain('"success":true')

    const messages = await h.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}/messages` })
    const body = messages.json() as MessageListResponse
    const assistant = body.messages.find((message) => message.role === 'assistant')
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      callId: 'call-1',
      tool: 'mcp__data-center__search_dataset',
      status: 'succeeded',
      durationMs: 10,
    })
  })

  it('模型错误：SSE 以 message.failed{TURN_ERROR} 结束，对话状态 failed', async () => {
    script = errorTurnScript
    const created = await createConversation({ inheritProjectConfig: false, systemPrompt: '会失败' })
    const conversationId = created.conversationId

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: '会失败吗' },
    })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('event: message.failed')
    expect(response.body).toContain('"code":"TURN_ERROR"')
    expect(response.body.match(/event: message\.failed/g)).toHaveLength(1)

    const detail = await h.app.inject({ method: 'GET', url: `/api/conversations/${conversationId}` })
    expect(detail.json()).toMatchObject({ status: 'failed', lastError: '模型限流' })
  })

  it('对话正在运行 → 409 CONVERSATION_RUNNING（不进入流）', async () => {
    const created = await createConversation()
    const conversationId = created.conversationId
    h.ctx.store.updateConversation(conversationId, { status: 'running' })

    const response = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${conversationId}/messages`,
      payload: { content: '再来一条' },
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: { code: string } }).error.code).toBe('CONVERSATION_RUNNING')
  })

  it('空 content → 400 VALIDATION_ERROR；未知对话 → 404', async () => {
    const created = await createConversation()
    const invalid = await h.app.inject({
      method: 'POST',
      url: `/api/conversations/${created.conversationId}/messages`,
      payload: { content: '' },
    })
    expect(invalid.statusCode).toBe(400)
    expect((invalid.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')

    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/conversations/conv-missing/messages',
      payload: { content: 'hi' },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('GET /api/runtimes 暴露 RuntimeInfo 字段（复用证明用）', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/runtimes' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { runtimes: Array<Record<string, unknown>> }
    expect(body.runtimes.length).toBeGreaterThan(0)
    expect(body.runtimes[0]).toMatchObject({
      runtimeId: expect.any(String),
      configKey: expect.stringMatching(/^[0-9a-f]{16}$/),
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      skills: expect.any(Array),
      mcpServers: expect.any(Array),
      conversationCount: expect.any(Number),
      runningCount: 0,
      startedAt: expect.any(Number),
      lastActiveAt: expect.any(Number),
    })
  })
})

describe('API：INTERNAL_TOKEN', () => {
  it('设置后 /api/* 要求 Bearer；错误令牌 → 401 SERVICE_TOKEN_INVALID', async () => {
    const secured = await createHarness({ internalToken: 'top-secret' })
    try {
      const unauthorized = await secured.app.inject({ method: 'GET', url: '/api/health' })
      expect(unauthorized.statusCode).toBe(401)
      expect((unauthorized.json() as { error: { code: string } }).error.code).toBe('SERVICE_TOKEN_INVALID')

      const wrong = await secured.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer nope' },
      })
      expect(wrong.statusCode).toBe(401)

      const ok = await secured.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer top-secret' },
      })
      expect(ok.statusCode).toBe(200)

      // 非 /api 路径不要求令牌（静态资源/前端）。
      const page = await secured.app.inject({ method: 'GET', url: '/nope' })
      expect(page.statusCode).toBe(404)
      expect((page.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
    } finally {
      await secured.close()
    }
  })
})

