/**
 * 测试装配：临时 DATA_DIR/RUNTIME_DIR + 真实 SQLite + 真实 Fastify inject。
 * 不启动 DSH 子进程、不联网。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { loadConfig, REPO_ROOT, type GatewayConfig } from '../src/config.js'
import { createLogger, silentLogger } from '../src/logger.js'
import { GatewayDatabase } from '../src/db/database.js'
import { seedDatabase } from '../src/db/seed.js'
import { UsersRepository } from '../src/repositories/users.js'
import { AgentsRepository } from '../src/repositories/agents.js'
import { AgentVersionsRepository } from '../src/repositories/agentVersions.js'
import { SessionsRepository } from '../src/repositories/sessions.js'
import { MessagesRepository } from '../src/repositories/messages.js'
import { ApprovalsRepository } from '../src/repositories/approvals.js'
import { AuditRepository } from '../src/repositories/audit.js'
import { McpServersRepository } from '../src/repositories/mcp.js'
import { RuntimesRepository } from '../src/repositories/runtimes.js'
import { SseHub } from '../src/runtime/SseHub.js'
import { ToolCatalog } from '../src/runtime/ToolCatalog.js'
import { RuntimeMaterializer } from '../src/runtime/RuntimeMaterializer.js'
import { DshProfileValidator } from '../src/runtime/ProfileValidator.js'
import { DshRuntimeManager } from '../src/runtime/DshRuntimeManager.js'
import { AgentService } from '../src/services/AgentService.js'
import { SessionService } from '../src/services/SessionService.js'
import { RunService } from '../src/services/RunService.js'
import type { AppContext } from '../src/context.js'
import { buildApp } from '../src/app.js'

export interface TestHarness {
  app: FastifyInstance
  ctx: AppContext
  config: GatewayConfig
  db: GatewayDatabase
  root: string
  close: () => Promise<void>
}

let sequence = 0

export function createConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  // 干净检出时 .tmp 可能还不存在，mkdtemp 不会自动创建父目录。
  const scratchRoot = path.join(REPO_ROOT, '.tmp')
  fs.mkdirSync(scratchRoot, { recursive: true })
  const root = fs.mkdtempSync(path.join(scratchRoot, 'gw-test-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATA_DIR: path.join(root, 'data'),
    RUNTIME_DIR: path.join(root, 'runtime'),
    AUTH_SECRET: `test-secret-${(sequence += 1)}-${'x'.repeat(40)}`,
    TOKEN_TTL_HOURS: '12',
    AGENT_STUDIO_DSH_PROFILE: 'studio',
    LOG_LEVEL: 'silent',
  }
  const config = loadConfig(env, REPO_ROOT)
  return { ...config, ...overrides }
}

/** 构建完整上下文（可只用于仓库/服务测试，不必 ready app）。 */
export function createContext(config: GatewayConfig = createConfig()): { ctx: AppContext; db: GatewayDatabase; root: string } {
  const db = new GatewayDatabase(path.join(config.dataDir, 'gateway.db'), silentLogger)
  db.migrate()
  seedDatabase(db, silentLogger)

  const users = new UsersRepository(db)
  const versions = new AgentVersionsRepository(db, silentLogger)
  const agents = new AgentsRepository(db, silentLogger, versions)
  const sessions = new SessionsRepository(db)
  const messages = new MessagesRepository(db, silentLogger)
  const approvals = new ApprovalsRepository(db)
  const audit = new AuditRepository(db)
  const mcp = new McpServersRepository(db, silentLogger)
  const runtimes = new RuntimesRepository(db)

  const hub = new SseHub(silentLogger)
  const toolCatalog = new ToolCatalog({ pluginToolsPath: config.pluginTools, mcpServers: mcp, logger: silentLogger })
  const materializer = new RuntimeMaterializer(config, silentLogger)
  const profileValidator = new DshProfileValidator(config, silentLogger)
  const runtime = new DshRuntimeManager({
    config,
    logger: silentLogger,
    sessions,
    messages,
    versions,
    approvals,
    audit,
    mcp,
    runtimes,
    hub,
    materializer,
    clientFactory: async () => {
      throw new Error('unit tests must not spawn DSH')
    },
  })

  const ctx: AppContext = {
    config,
    logger: silentLogger,
    db,
    repos: { users, agents, versions, sessions, messages, approvals, audit, mcp, runtimes },
    services: {
      agents: new AgentService({
        config,
        db,
        agents,
        versions,
        mcpServers: mcp,
        toolCatalog,
        materializer,
        profileValidator,
        logger: silentLogger,
      }),
      sessions: new SessionService({
        agents,
        sessions,
        messages,
        approvals,
        runtime,
        logger: silentLogger,
      }),
      runs: new RunService({
        sessions,
        messages,
        versions,
        runtime,
        hub,
        toolCatalog,
        logger: silentLogger,
      }),
    },
    hub,
    runtime,
    toolCatalog,
    probeMcp: async () => ({ ok: false, tools: [], error: 'not available in unit tests' }),
    startedAt: Date.now(),
  }
  return { ctx, db, root: path.dirname(config.dataDir) }
}

export async function createHarness(overrides: Partial<GatewayConfig> = {}): Promise<TestHarness> {
  const config = createConfig(overrides)
  const { ctx, db, root } = createContext(config)
  const app = await buildApp(ctx)
  await app.ready()
  return {
    app,
    ctx,
    config,
    db,
    root,
    close: async () => {
      await app.close().catch(() => undefined)
      await ctx.runtime.stopAll().catch(() => undefined)
      ctx.hub.shutdown()
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

export async function login(app: FastifyInstance, username: string, password: string): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  })
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`)
  const body = response.json() as { token: string }
  return body.token
}

export function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

export function makeLogger() {
  return createLogger('silent')
}
