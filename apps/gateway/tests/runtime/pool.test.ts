import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentConfigSnapshot, MessageDto, ServiceEvent, ToolCallRecord } from '@agent-studio/shared'
import { silentLogger } from '../../src/logger.js'
import type { McpConfig } from '../../src/mcp/McpConfig.js'
import { McpConfig as Mcp } from '../../src/mcp/McpConfig.js'
import { computeConfigKey } from '../../src/runtime/ConfigKey.js'
import { RuntimePool, type RuntimeConversationSink } from '../../src/runtime/RuntimePool.js'
import { SnapshotMaterializer } from '../../src/runtime/SnapshotMaterializer.js'
import { SseHub } from '../../src/runtime/SseHub.js'
import { SkillCatalog } from '../../src/skills/Catalog.js'
import { SkillSource } from '../../src/skills/SkillSource.js'
import {
  createFakeClientFactory,
  createTestConfig,
  makeTempDir,
  writeSkill,
  writeTemplate,
  type FakeFactoryHandle,
  type TurnScript,
} from '../helpers.js'

const scratch: string[] = []

class FakeSink implements RuntimeConversationSink {
  readonly idles: string[] = []
  readonly failures: Array<{ conversationId: string; message: string }> = []
  readonly appended: MessageDto[] = []
  readonly toolUpdates: Array<{ conversationId: string; messageId: string; toolCalls: ToolCallRecord[] }> = []

  markIdle(conversationId: string): void {
    this.idles.push(conversationId)
  }

  markFailed(conversationId: string, message: string): void {
    this.failures.push({ conversationId, message })
  }

  appendAssistant(conversationId: string, input: { text: string; toolCalls: ToolCallRecord[] }): MessageDto {
    const message: MessageDto = {
      id: `asst-${this.appended.length + 1}`,
      conversationId,
      role: 'assistant',
      content: input.text,
      sequence: this.appended.length + 2,
      createdAt: Date.now(),
      ...(input.toolCalls.length === 0 ? {} : { toolCalls: input.toolCalls.map((call) => ({ ...call })) }),
    }
    this.appended.push(message)
    return message
  }

  updateToolCalls(conversationId: string, messageId: string, toolCalls: ToolCallRecord[]): void {
    this.toolUpdates.push({ conversationId, messageId, toolCalls: toolCalls.map((call) => ({ ...call })) })
  }
}

interface PoolFixture {
  pool: RuntimePool
  sink: FakeSink
  hub: SseHub
  fake: FakeFactoryHandle
  root: string
  snapshot: (overrides?: Partial<AgentConfigSnapshot>) => AgentConfigSnapshot
}

const noIdleScript: TurnScript = () => []
const errorScript: TurnScript = ({ sessionId }) => [
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'turn/end',
        seq: 2,
        time: Date.now(),
        data: { turn: 1, reason: { kind: 'error', error: { message: '模型错误', code: 'LLM_ERROR' } } },
      },
    },
  },
  { method: 'session.status', params: { sessionId, status: 'idle' } },
]

function createPoolFixture(
  options: {
    script?: TurnScript
    maxRuntimes?: number
    runtimeIdleMs?: number
    turnTimeoutMs?: number
  } = {},
): PoolFixture {
  const root = makeTempDir('pool')
  scratch.push(root)

  const skillsDir = path.join(root, 'skills')
  writeSkill(skillsDir, { name: 'netcdf-analysis', description: '分析 NetCDF', bundle: true })
  const mcpConfigPath = path.join(root, 'config', 'mcp-servers.json')
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true })
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ servers: [] }), 'utf8')
  const templateDir = path.join(root, 'templates')
  writeTemplate(templateDir)

  const config = createTestConfig({
    root,
    skillsDir,
    mcpConfigPath,
    templateDir,
    overrides: {
      ...(options.maxRuntimes === undefined ? {} : { maxRuntimes: options.maxRuntimes }),
      ...(options.runtimeIdleMs === undefined ? {} : { runtimeIdleMs: options.runtimeIdleMs }),
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
    },
  })

  const catalog = new SkillCatalog({ roots: [{ path: skillsDir, source: 'project' }], logger: silentLogger })
  const skills = new SkillSource(catalog, silentLogger)
  const mcp: McpConfig = new Mcp({ configPath: mcpConfigPath, logger: silentLogger, repoRoot: root, env: {} })
  const materializer = new SnapshotMaterializer({ config, logger: silentLogger, skills, mcp })

  const fake = createFakeClientFactory(options.script)
  const sink = new FakeSink()
  const hub = new SseHub(silentLogger)
  const pool = new RuntimePool({
    config: {
      dshBin: config.dshBin,
      dshProfile: config.dshProfile,
      runtimeIdleMs: config.runtimeIdleMs,
      turnTimeoutMs: config.turnTimeoutMs,
      maxRuntimes: config.maxRuntimes,
    },
    logger: silentLogger,
    materializer,
    hub,
    sink,
    clientFactory: fake.factory,
  })

  const snapshot = (overrides: Partial<AgentConfigSnapshot> = {}): AgentConfigSnapshot => {
    const base = {
      skills: [] as string[],
      mcpServers: [] as string[],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      systemPrompt: '',
      ...overrides,
    }
    return {
      ...base,
      configKey: computeConfigKey(base),
      projectId: 'p1',
      createdAt: 1_000,
      inheritedFromProject: true,
      ...overrides,
    }
  }

  return { pool, sink, hub, fake, root, snapshot }
}

function collect(hub: SseHub, conversationId: string): ServiceEvent[] {
  const events: ServiceEvent[] = []
  hub.subscribe(conversationId, (event) => events.push(event))
  return events
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

describe('runtime/RuntimePool', () => {
  it('同 configKey 复用同一个运行时（多个对话共享）', async () => {
    const fixture = createPoolFixture()
    const config = fixture.snapshot({ skills: ['netcdf-analysis'] })

    const first = await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config,
      text: '你好',
      hasHistory: false,
    })
    const second = await fixture.pool.send({
      conversationId: 'conv-b',
      sessionId: 'dsh-b',
      config,
      text: '再来',
      hasHistory: false,
    })

    expect(first.outcome).toBe('idle')
    expect(second.outcome).toBe('idle')
    expect(fixture.fake.clients).toHaveLength(1)
    expect(fixture.fake.clients[0]?.prompts).toHaveLength(2)
    expect(fixture.pool.status()).toHaveLength(1)
    expect(fixture.pool.status()[0]).toMatchObject({
      configKey: config.configKey,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      skills: ['netcdf-analysis'],
      mcpServers: [],
      conversationCount: 2,
      runningCount: 0,
    })
  })

  it('不同 configKey → 不同运行时（不同 home）', async () => {
    const fixture = createPoolFixture()
    await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config: fixture.snapshot(),
      text: '一',
      hasHistory: false,
    })
    await fixture.pool.send({
      conversationId: 'conv-b',
      sessionId: 'dsh-b',
      config: fixture.snapshot({ systemPrompt: '另一个人设' }),
      text: '二',
      hasHistory: false,
    })

    expect(fixture.fake.clients).toHaveLength(2)
    expect(fixture.fake.options[0]?.dshHome).not.toBe(fixture.fake.options[1]?.dshHome)
    expect(fixture.pool.status()).toHaveLength(2)
  })

  it('一轮成功：落库助手消息、状态置 idle、SSE 收到 message.completed', async () => {
    const fixture = createPoolFixture()
    const events = collect(fixture.hub, 'conv-a')
    const config = fixture.snapshot()

    const result = await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config,
      text: '你好',
      hasHistory: false,
    })

    expect(result).toMatchObject({ outcome: 'idle' })
    expect(fixture.sink.appended).toHaveLength(1)
    expect(fixture.sink.appended[0]).toMatchObject({ role: 'assistant', content: '第 1 轮回答' })
    expect(fixture.sink.idles).toEqual(['conv-a'])
    expect(events).toEqual([expect.objectContaining({ type: 'message.completed', text: '第 1 轮回答' })])
  })

  it('回收后重建：已有 sessionId 先 resumeSession() 再 prompt()', async () => {
    const fixture = createPoolFixture({ runtimeIdleMs: 0 })
    const config = fixture.snapshot()

    await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config,
      text: '第一轮',
      hasHistory: false,
    })
    await fixture.pool.reapNow()
    expect(fixture.fake.clients[0]?.closeCalls).toBe(1)
    expect(fixture.pool.status()).toHaveLength(0)

    await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config,
      text: '第二轮',
      hasHistory: true,
    })
    expect(fixture.fake.clients).toHaveLength(2)
    expect(fixture.fake.clients[1]?.resumed).toEqual(['dsh-a'])
    // 首次消息不 resume（新会话不存在，resume 只会报错）。
    expect(fixture.fake.clients[0]?.resumed).toEqual([])
  })

  it('空闲回收：无运行中对话且超过 RUNTIME_IDLE_MS → close()', async () => {
    const fixture = createPoolFixture({ runtimeIdleMs: 0 })
    await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config: fixture.snapshot(),
      text: '你好',
      hasHistory: false,
    })
    expect(fixture.pool.status()).toHaveLength(1)
    await fixture.pool.reapNow()
    expect(fixture.pool.status()).toHaveLength(0)
    expect(fixture.fake.clients[0]?.closeCalls).toBe(1)
  })

  it('运行时上限：没有可回收的空闲运行时 → 503 RUNTIME_ERROR', async () => {
    const fixture = createPoolFixture({ maxRuntimes: 1, script: noIdleScript })
    const pending = fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config: fixture.snapshot(),
      text: '占住',
      hasHistory: false,
    })
    await waitFor(() => fixture.pool.status()[0]?.runningCount === 1)

    const error: unknown = await fixture.pool
      .send({
        conversationId: 'conv-b',
        sessionId: 'dsh-b',
        config: fixture.snapshot({ systemPrompt: '另一个人设' }),
        text: '挤不进来',
        hasHistory: false,
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      )
    expect(error).toMatchObject({ code: 'RUNTIME_ERROR', statusCode: 503 })

    fixture.fake.clients[0]?.crash('test cleanup')
    await pending
  })

  it('传输层关闭：运行中的对话收到 message.failed{RUNTIME_CLOSED}', async () => {
    const fixture = createPoolFixture({ script: noIdleScript })
    const events = collect(fixture.hub, 'conv-a')
    const pending = fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config: fixture.snapshot(),
      text: '跑着跑着挂了',
      hasHistory: false,
    })
    await waitFor(() => fixture.pool.status()[0]?.runningCount === 1)

    fixture.fake.clients[0]?.crash('子进程退出 code=1')
    const result = await pending

    expect(result.outcome).toBe('failed')
    expect(events).toEqual([
      expect.objectContaining({ type: 'message.failed', code: 'RUNTIME_CLOSED', message: '子进程退出 code=1' }),
    ])
    expect(fixture.sink.failures).toEqual([{ conversationId: 'conv-a', message: '子进程退出 code=1' }])
    expect(fixture.pool.status()).toHaveLength(0)
  })

  it('turn/end 错误：结果为 failed，且运行时保留（下一轮可继续）', async () => {
    const fixture = createPoolFixture({ script: errorScript })
    const events = collect(fixture.hub, 'conv-a')
    const result = await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config: fixture.snapshot(),
      text: '会失败',
      hasHistory: false,
    })
    expect(result.outcome).toBe('failed')
    expect(events).toEqual([expect.objectContaining({ type: 'message.failed', code: 'TURN_ERROR' })])
    expect(fixture.pool.status()).toHaveLength(1)
  })

  it('TURN_TIMEOUT_MS 超时：发 TIMEOUT 失败并关闭该运行时', async () => {
    const fixture = createPoolFixture({ script: noIdleScript, turnTimeoutMs: 40 })
    const events = collect(fixture.hub, 'conv-a')
    const result = await fixture.pool.send({
      conversationId: 'conv-a',
      sessionId: 'dsh-a',
      config: fixture.snapshot(),
      text: '永远不结束',
      hasHistory: false,
    })

    expect(result.outcome).toBe('failed')
    expect(events).toEqual([expect.objectContaining({ type: 'message.failed', code: 'TIMEOUT' })])
    expect(fixture.fake.clients[0]?.closeCalls).toBe(1)
    expect(fixture.pool.status()).toHaveLength(0)
  })
})
