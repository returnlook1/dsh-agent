/**
 * 测试装配：临时 DATA_DIR/RUNTIME_DIR/技能目录/模板目录 + 真实 Fastify inject。
 *
 * 硬约束：**单测不启动真实 DSH**。运行时客户端一律由 `FakeRuntimeClient` 注入，
 * 真实链路（真子进程）由脚本层 smoke/e2e 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { ProviderOption, SkillSummaryDto } from '@agent-studio/shared'
import { ModelCatalogService } from '../src/models/ModelCatalogService.js'
import { REPO_ROOT, loadConfig, type GatewayConfig } from '../src/config.js'
import { silentLogger } from '../src/logger.js'
import { createServices } from '../src/server.js'
import { buildApp } from '../src/app.js'
import type { AppContext } from '../src/context.js'
import type {
  NotificationSubscriptionLike,
  RuntimeClient,
  RuntimeClientFactory,
  RuntimeClientOptions,
} from '../src/runtime/RuntimePool.js'

/* ------------------------------------------------------------------ 临时目录 */

let sequence = 0

/** 在 `<repo>/.tmp` 下建一个独立临时目录（干净检出时 .tmp 可能不存在）。 */
export function makeTempDir(prefix = 'svc-test'): string {
  const scratch = path.join(REPO_ROOT, '.tmp')
  fs.mkdirSync(scratch, { recursive: true })
  sequence += 1
  return fs.mkdtempSync(path.join(scratch, `${prefix}-${sequence}-`))
}

/* ------------------------------------------------------------------ 技能夹具 */

export interface SkillFixture {
  name: string
  description: string
  whenToUse?: string
  /** true = 目录 bundle（SKILL.md），false = 单文件 `<name>.md`。 */
  bundle?: boolean
  /** 覆盖整个文件内容（用于非法 frontmatter 用例）。 */
  raw?: string
}

export function writeSkill(rootDir: string, fixture: SkillFixture): string {
  fs.mkdirSync(rootDir, { recursive: true })
  const frontmatter = ['---', `name: ${fixture.name}`, `description: ${fixture.description}`]
  if (fixture.whenToUse !== undefined) frontmatter.push(`whenToUse: ${fixture.whenToUse}`)
  frontmatter.push('---', '', '正文：按步骤操作。', '')
  const content = fixture.raw ?? frontmatter.join('\n')
  if (fixture.bundle === true) {
    const dir = path.join(rootDir, fixture.name)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'SKILL.md')
    fs.writeFileSync(file, content, 'utf8')
    return file
  }
  const file = path.join(rootDir, `${fixture.name}.md`)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

/* ------------------------------------------------------------------ 模板夹具 */

/** 写一份与 Lead 模板同形状的最小模板（三个占位符都出现）。 */
export function writeTemplate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'dsh-profile-agent-service',
        private: true,
        dependencies: {},
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } },
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    [
      '# 测试用模板（与 runtime/templates/agent-service 同形状）',
      '- id: sandbox-policy',
      '  config:',
      '    mode: read-only',
      "    workspaceRoot: '{{WORKSPACE}}'",
      '- insert:',
      '    - id: skill-filesystem',
      "      name: '@deepseek-ai/dsh-skill-filesystem'",
      '      config:',
      '        includeDefaultRoots: false',
      '        customSkillDirs:',
      "          - '{{SKILLS_VIEW}}'",
      '    - id: agent-tools',
      "      name: '{{TOOLS_PLUGIN}}'",
      '',
    ].join('\n'),
    'utf8',
  )
}

/* ------------------------------------------------------------------ 模型清单夹具 */

/**
 * 测试默认模型清单：**故意与 DSH 内建目录一致**，但测试完全靠注入，
 * 不启动 DSH、不依赖真实 provider。
 */
export const DEFAULT_TEST_PROVIDERS: ProviderOption[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576 },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', description: '更强推理' },
    ],
  },
]

/** 用假发现构造一个已经就绪的模型清单服务（单测不 spawn 任何进程）。 */
export function createSeededModels(options: {
  root: string
  providers?: ProviderOption[]
  now?: () => number
}): ModelCatalogService {
  const providers = options.providers ?? DEFAULT_TEST_PROVIDERS
  return new ModelCatalogService({
    discovery: {
      discover: async () => ({ providers, probedAt: (options.now ?? Date.now)() }),
    },
    logger: silentLogger,
    cachePath: path.join(options.root, 'data', 'models.json'),
    now: options.now,
  })
}

/* ------------------------------------------------------------------ 假运行时 */

export type TurnScript = (context: { client: FakeRuntimeClient; sessionId: string; turn: number }) => HarnessNotification[]

/** 一个成功的 turn：一条 assistant/message + idle。 */
export const defaultTurnScript: TurnScript = ({ sessionId, turn }) => [
  {
    method: 'session.event',
    params: {
      sessionId,
      event: {
        type: 'assistant/message',
        seq: turn * 2,
        time: Date.now(),
        data: {
          turn,
          step: 1,
          message: {
            role: 'assistant',
            id: `assistant-${turn}`,
            content: [{ type: 'text', text: `第 ${turn} 轮回答` }],
            source: { kind: 'model' },
          },
        },
      },
    },
  },
  { method: 'session.status', params: { sessionId, status: 'idle' } },
]

/**
 * 假运行时客户端：记录调用、按脚本推送通知。
 * 单测里**绝不会** spawn 任何进程。
 */
export class FakeRuntimeClient implements RuntimeClient {
  readonly prompts: Array<{ sessionId: string; text: string }> = []
  readonly resumed: string[] = []
  readonly initializeCalls: Array<{ cwd: string; provider: string; model: string }> = []
  startCalls = 0
  closeCalls = 0

  private readonly queue: HarnessNotification[] = []
  private readonly waiters: Array<{ resolve: (n: HarnessNotification) => void; reject: (error: unknown) => void }> = []
  private readonly tokens = new Set<object>()
  private closed = false

  constructor(public script: TurnScript = defaultTurnScript) {}

  start(): void {
    this.startCalls += 1
  }

  async initialize(params: { cwd: string; provider: string; model: string }): Promise<unknown> {
    this.initializeCalls.push(params)
    return { serverInfo: { name: 'fake-dsh', version: 'test' } }
  }

  async prompt(sessionId: string, contentBlocks: Array<{ type: 'text'; text: string }>): Promise<string> {
    this.prompts.push({ sessionId, text: contentBlocks.map((block) => block.text).join('') })
    const notifications = this.script({ client: this, sessionId, turn: this.prompts.length })
    queueMicrotask(() => {
      for (const notification of notifications) this.emit(notification)
    })
    return `fake-inbox-${this.prompts.length}`
  }

  async resumeSession(sessionId: string): Promise<void> {
    this.resumed.push(sessionId)
  }

  subscribe(): NotificationSubscriptionLike {
    const token = {}
    this.tokens.add(token)
    return {
      next: () => this.next(token),
      close: () => {
        this.tokens.delete(token)
      },
    }
  }

  async close(): Promise<void> {
    this.closeCalls += 1
    this.closed = true
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const waiter of waiters) waiter.reject(new Error('runtime closed'))
  }

  /** 主动投递一条通知（脚本或测试用）。 */
  emit(notification: HarnessNotification): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) {
      waiter.resolve(notification)
      return
    }
    this.queue.push(notification)
  }

  /** 模拟传输层断开（子进程退出）。 */
  crash(message = 'fake runtime exited'): void {
    this.closed = true
    const waiters = this.waiters.splice(0, this.waiters.length)
    for (const waiter of waiters) waiter.reject(new Error(message))
  }

  private next(token: object): Promise<HarnessNotification> {
    if (!this.tokens.has(token) || this.closed) return Promise.reject(new Error('runtime closed'))
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<HarnessNotification>((resolve, reject) => {
      this.waiters.push({ resolve, reject })
    })
  }
}

export interface FakeFactoryHandle {
  factory: RuntimeClientFactory
  clients: FakeRuntimeClient[]
  options: RuntimeClientOptions[]
}

/** 每个运行时一个新的假客户端，脚本可统一注入。 */
export function createFakeClientFactory(script: TurnScript = defaultTurnScript): FakeFactoryHandle {
  const clients: FakeRuntimeClient[] = []
  const options: RuntimeClientOptions[] = []
  const factory: RuntimeClientFactory = (clientOptions) => {
    options.push(clientOptions)
    const client = new FakeRuntimeClient(script)
    clients.push(client)
    return client
  }
  return { factory, clients, options }
}

/* ------------------------------------------------------------------ 配置 */

export interface TestConfigOptions {
  root: string
  skillsDir?: string
  mcpConfigPath?: string
  templateDir?: string
  overrides?: Partial<GatewayConfig>
}

export function createTestConfig(options: TestConfigOptions): GatewayConfig {
  const { root } = options
  const config = loadConfig(
    {
      PATH: process.env.PATH,
      SYSTEMROOT: process.env.SYSTEMROOT,
      TEMP: process.env.TEMP,
      DATA_DIR: path.join(root, 'data'),
      RUNTIME_DIR: path.join(root, 'runtime'),
      SKILLS_DIRS: options.skillsDir ?? path.join(root, 'skills'),
      MCP_CONFIG: options.mcpConfigPath ?? path.join(root, 'config', 'mcp-servers.json'),
      AGENT_SERVICE_DSH_PROFILE: 'agent-service',
      AGENT_SERVICE_PLUGIN_TOOLS: path.join(root, 'plugin-tools.js'),
      DEEPSEEK_API_KEY: 'unit-test-key',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1',
      LOG_LEVEL: 'silent',
    },
    REPO_ROOT,
  )
  return {
    ...config,
    templateDir: options.templateDir ?? path.join(root, 'templates'),
    ...options.overrides,
  }
}

/* ------------------------------------------------------------------ 应用夹具 */

export interface HarnessOptions {
  skills?: SkillFixture[]
  /** MCP 服务器定义；undefined = 写一个空清单文件。 */
  mcpServers?: unknown[]
  clientFactory?: RuntimeClientFactory
  turnTimeoutMs?: number
  runtimeIdleMs?: number
  maxRuntimes?: number
  internalToken?: string
  /** 不写模板（用于"模板缺失"用例）。 */
  skipTemplate?: boolean
  /** 覆盖测试用模型清单（默认只有 deepseek-official 两个模型）。 */
  providers?: ProviderOption[]
}

export interface TestHarness {
  app: FastifyInstance
  ctx: AppContext
  config: GatewayConfig
  root: string
  skillsDir: string
  mcpConfigPath: string
  close: () => Promise<void>
}

export async function createHarness(options: HarnessOptions = {}): Promise<TestHarness> {
  const root = makeTempDir('svc')
  const skillsDir = path.join(root, 'skills')
  fs.mkdirSync(skillsDir, { recursive: true })
  for (const fixture of options.skills ?? []) writeSkill(skillsDir, fixture)

  const mcpConfigPath = path.join(root, 'config', 'mcp-servers.json')
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true })
  fs.writeFileSync(mcpConfigPath, `${JSON.stringify({ servers: options.mcpServers ?? [] }, null, 2)}\n`, 'utf8')

  const templateDir = path.join(root, 'templates')
  if (options.skipTemplate !== true) writeTemplate(templateDir)

  const config = createTestConfig({
    root,
    skillsDir,
    mcpConfigPath,
    templateDir,
    overrides: {
      ...(options.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: options.turnTimeoutMs }),
      ...(options.runtimeIdleMs === undefined ? {} : { runtimeIdleMs: options.runtimeIdleMs }),
      ...(options.maxRuntimes === undefined ? {} : { maxRuntimes: options.maxRuntimes }),
      ...(options.internalToken === undefined ? {} : { internalToken: options.internalToken }),
    },
  })

  const handle = createFakeClientFactory()
  const models = createSeededModels({ root, ...(options.providers === undefined ? {} : { providers: options.providers }) })
  const ctx = createServices(config, silentLogger, {
    clientFactory: options.clientFactory ?? handle.factory,
    models,
  })
  // 假发现是同步完成的：ensure 让清单在 app.ready() 前就绪。
  await ctx.models.ensure()
  const app = await buildApp(ctx)
  await app.ready()

  return {
    app,
    ctx,
    config,
    root,
    skillsDir,
    mcpConfigPath,
    close: async () => {
      await app.close().catch(() => undefined)
      await ctx.pool.closeAll().catch(() => undefined)
      ctx.hub.shutdown()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

/** 断言一个技能出现在技能清单里（测试辅助，返回该条）。 */
export function findSkill(skills: SkillSummaryDto[], name: string): SkillSummaryDto | undefined {
  return skills.find((skill) => skill.name === name)
}
