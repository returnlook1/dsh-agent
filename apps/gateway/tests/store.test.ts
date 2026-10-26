import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentConfig, ConversationDto, MessageDto } from '@agent-studio/shared'
import { silentLogger } from '../src/logger.js'
import { defaultAgentConfig } from '../src/service/Conversations.js'
import { MessageLog } from '../src/store/MessageLog.js'
import { Store } from '../src/store/Store.js'
import { makeTempDir } from './helpers.js'

const scratch: string[] = []

function tempDir(): string {
  const dir = makeTempDir('store')
  scratch.push(dir)
  return dir
}

function makeStore(): { store: Store; filePath: string } {
  const filePath = path.join(tempDir(), 'store.json')
  const store = new Store(filePath, silentLogger)
  store.init()
  return { store, filePath }
}

function makeConversation(id: string, overrides: Partial<ConversationDto> = {}): ConversationDto {
  const config: AgentConfig = defaultAgentConfig()
  return {
    id,
    projectId: 'p1',
    sessionId: `dsh-${id}`,
    config: {
      ...config,
      configKey: '0123456789abcdef',
      capabilityRevision: 'test',
      projectId: 'p1',
      createdAt: 1,
      inheritedFromProject: true,
    },
    status: 'idle',
    title: '',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    ...overrides,
  }
}

function makeMessage(conversationId: string, sequence: number, role: MessageDto['role'] = 'user'): MessageDto {
  return {
    id: `msg-${sequence}`,
    conversationId,
    role,
    content: `内容 ${sequence}`,
    sequence,
    createdAt: 1_000 + sequence,
  }
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

describe('store/Store', () => {
  it('原子写：落盘后目录里没有临时文件，JSON 可解析', () => {
    const { store, filePath } = makeStore()
    store.saveProject('p1', defaultAgentConfig())

    const files = fs.readdirSync(path.dirname(filePath))
    expect(files.filter((name) => name.includes('.tmp-'))).toEqual([])
    expect(() => JSON.parse(fs.readFileSync(filePath, 'utf8'))).not.toThrow()
    expect(store.getProject('p1')?.config.provider).toBe(defaultAgentConfig().provider)
    expect(store.getProject('p1')?.updatedAt).toBeGreaterThan(0)
  })

  it('损坏恢复：备份为 store.json.corrupt-<ts>，以空状态启动且文件恢复合法', () => {
    const dir = tempDir()
    const filePath = path.join(dir, 'store.json')
    fs.writeFileSync(filePath, '{ this is not json', 'utf8')

    const store = new Store(filePath, silentLogger)
    store.init()

    expect(store.getProject('p1')).toBeUndefined()
    const backups = fs.readdirSync(dir).filter((name) => name.startsWith('store.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toMatchObject({ version: 1, projects: {}, conversations: {} })
  })

  it('重启后能读回项目配置与对话', () => {
    const dir = tempDir()
    const filePath = path.join(dir, 'store.json')
    const first = new Store(filePath, silentLogger)
    first.init()
    first.saveProject('ocean-project', { ...defaultAgentConfig(), skills: ['netcdf-analysis'] })
    first.createConversation(makeConversation('conv-1'))

    const second = new Store(filePath, silentLogger)
    second.init()
    expect(second.getProject('ocean-project')?.config.skills).toEqual(['netcdf-analysis'])
    expect(second.getConversation('conv-1')?.sessionId).toBe('dsh-conv-1')
  })

  it('对话列表按 updatedAt 倒序、支持 projectId 过滤与 limit', () => {
    const { store } = makeStore()
    store.createConversation(makeConversation('conv-a', { projectId: 'p1', updatedAt: 10 }))
    store.createConversation(makeConversation('conv-b', { projectId: 'p1', updatedAt: 30 }))
    store.createConversation(makeConversation('conv-c', { projectId: 'p2', updatedAt: 20 }))

    expect(store.listConversations({ projectId: 'p1' }).map((item) => item.id)).toEqual(['conv-b', 'conv-a'])
    expect(store.listConversations().map((item) => item.id)).toEqual(['conv-b', 'conv-c', 'conv-a'])
    expect(store.listConversations({ limit: 1 }).map((item) => item.id)).toEqual(['conv-b'])
  })

  it('updateConversation 保持 id 不变并刷新 updatedAt', () => {
    const { store } = makeStore()
    store.createConversation(makeConversation('conv-1', { updatedAt: 1 }))
    const updated = store.updateConversation('conv-1', { status: 'failed', lastError: 'boom' })
    expect(updated).toMatchObject({ id: 'conv-1', status: 'failed', lastError: 'boom' })
    expect(updated?.updatedAt).toBeGreaterThan(1)
    expect(store.updateConversation('missing', { status: 'idle' })).toBeUndefined()
  })

  it('启动修复：遗留的 running 对话被置回 idle（避免永久锁死）', () => {
    const dir = tempDir()
    const filePath = path.join(dir, 'store.json')
    const first = new Store(filePath, silentLogger)
    first.init()
    first.createConversation(makeConversation('conv-running', { status: 'running' }))
    first.createConversation(makeConversation('conv-idle'))

    const second = new Store(filePath, silentLogger)
    second.init()
    expect(second.repairRunningConversations()).toBe(1)
    expect(second.getConversation('conv-running')).toMatchObject({
      status: 'idle',
      lastError: '服务重启时该轮未完成',
    })
    expect(second.repairRunningConversations()).toBe(0)
  })
})

describe('store/MessageLog', () => {
  it('并发追加 20 条：一行一条、顺序稳定、内容完整', async () => {
    const dir = path.join(tempDir(), 'conversations')
    const log = new MessageLog(dir, silentLogger)
    log.init()

    await Promise.all(
      Array.from({ length: 20 }, async (_unused, index) =>
        log.append(makeMessage('conv-1', index + 1, index % 2 === 0 ? 'user' : 'assistant')),
      ),
    )

    const result = log.list('conv-1')
    expect(result.truncated).toBe(false)
    expect(result.messages).toHaveLength(20)
    expect(result.messages.map((message) => message.sequence)).toEqual(
      Array.from({ length: 20 }, (_unused, index) => index + 1),
    )
    expect(result.messages[19]?.content).toBe('内容 20')
  })

  it('半行（进程崩溃残留）被跳过并标记 truncated', () => {
    const dir = path.join(tempDir(), 'conversations')
    const log = new MessageLog(dir, silentLogger)
    log.init()
    log.append(makeMessage('conv-2', 1))
    fs.appendFileSync(path.join(dir, 'conv-2.jsonl'), '{"id":"broken"', 'utf8')

    const result = log.list('conv-2')
    expect(result.messages).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('patch 更新工具调用状态（重写整份 JSONL）', () => {
    const dir = path.join(tempDir(), 'conversations')
    const log = new MessageLog(dir, silentLogger)
    log.init()
    const message = makeMessage('conv-3', 1, 'assistant')
    log.append({ ...message, toolCalls: [{ callId: 'c1', tool: 'search', status: 'running' }] })

    const updated = log.patch('conv-3', message.id, (current) => ({
      ...current,
      toolCalls: [{ callId: 'c1', tool: 'search', status: 'succeeded', durationMs: 12 }],
    }))
    expect(updated?.toolCalls?.[0]).toMatchObject({ status: 'succeeded', durationMs: 12 })
    expect(log.list('conv-3').messages[0]?.toolCalls?.[0]?.status).toBe('succeeded')
  })

  it('拒绝带路径分隔符的对话 id（防御目录穿越）', () => {
    const log = new MessageLog(path.join(tempDir(), 'conversations'), silentLogger)
    expect(() => log.list('../../etc/passwd')).toThrow(/invalid conversationId/)
  })
})
