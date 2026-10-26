/**
 * 启动装配（docs/IMPL-GATEWAY.md §11）：
 * config → db(迁移/种子) → repos → runtime/services → routes → listen → graceful shutdown。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, describeConfig } from './config.js'
import { createLogger } from './logger.js'
import { GatewayDatabase } from './db/database.js'
import { seedDatabase } from './db/seed.js'
import { UsersRepository } from './repositories/users.js'
import { AgentsRepository } from './repositories/agents.js'
import { AgentVersionsRepository } from './repositories/agentVersions.js'
import { SessionsRepository } from './repositories/sessions.js'
import { MessagesRepository } from './repositories/messages.js'
import { ApprovalsRepository } from './repositories/approvals.js'
import { AuditRepository } from './repositories/audit.js'
import { McpServersRepository } from './repositories/mcp.js'
import { RuntimesRepository } from './repositories/runtimes.js'
import { SseHub } from './runtime/SseHub.js'
import { ToolCatalog } from './runtime/ToolCatalog.js'
import { RuntimeMaterializer } from './runtime/RuntimeMaterializer.js'
import { DshProfileValidator, type ProfileValidator } from './runtime/ProfileValidator.js'
import { DshRuntimeManager } from './runtime/DshRuntimeManager.js'
import { probeMcpServer } from './runtime/McpProbe.js'
import { AgentService } from './services/AgentService.js'
import { SessionService } from './services/SessionService.js'
import { RunService } from './services/RunService.js'
import type { AppContext } from './context.js'
import { buildApp } from './app.js'

const SELF = fileURLToPath(import.meta.url)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 崩溃后清理：把遗留 running 记录置 stopped，并按 pid 尽力结束孤儿子进程。 */
function repairAfterCrash(ctx: AppContext): void {
  const sessions = ctx.repos.sessions.repairRunningSessions()
  if (sessions > 0) ctx.logger.warn('repaired orphan running sessions', { count: sessions })

  const orphanRuntimes = ctx.repos.runtimes.markOrphansStopped()
  for (const orphan of orphanRuntimes) {
    if (orphan.pid === null) continue
    const pid = Number(orphan.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGTERM')
      ctx.logger.warn('sent SIGTERM to orphan runtime process', { pid, runtimeId: orphan.id })
    } catch {
      // 进程已不存在或无权结束：忽略。
    }
  }

  const expired = ctx.repos.approvals.expireAllPending()
  if (expired.length > 0) {
    ctx.logger.warn('expired stale pending approvals on boot', { count: expired.length })
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config.logLevel).child({ component: 'gateway' })
  logger.info('starting agent gateway', describeConfig(config))
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(config.runtimeDir, { recursive: true })

  const db = new GatewayDatabase(path.join(config.dataDir, 'gateway.db'), logger)
  db.migrate()
  seedDatabase(db, logger)

  const users = new UsersRepository(db)
  const versions = new AgentVersionsRepository(db, logger)
  const agents = new AgentsRepository(db, logger, versions)
  const sessions = new SessionsRepository(db)
  const messages = new MessagesRepository(db, logger)
  const approvals = new ApprovalsRepository(db)
  const audit = new AuditRepository(db)
  const mcp = new McpServersRepository(db, logger)
  const runtimes = new RuntimesRepository(db)

  const hub = new SseHub(logger)
  const toolCatalog = new ToolCatalog({
    pluginToolsPath: config.pluginTools,
    mcpServers: mcp,
    logger: logger.child({ component: 'tool-catalog' }),
  })
  const materializer = new RuntimeMaterializer(config, logger.child({ component: 'materializer' }))
  const profileValidator: ProfileValidator = new DshProfileValidator(
    config,
    logger.child({ component: 'profile-validator' }),
  )
  const runtime = new DshRuntimeManager({
    config,
    logger: logger.child({ component: 'runtime' }),
    sessions,
    messages,
    versions,
    approvals,
    audit,
    mcp,
    runtimes,
    hub,
    materializer,
  })

  const agentService = new AgentService({
    config,
    db,
    agents,
    versions,
    mcpServers: mcp,
    toolCatalog,
    materializer,
    profileValidator,
    logger: logger.child({ component: 'agent-service' }),
  })
  const sessionService = new SessionService({
    agents,
    sessions,
    messages,
    approvals,
    runtime,
    logger: logger.child({ component: 'session-service' }),
  })
  const runService = new RunService({
    sessions,
    messages,
    versions,
    runtime,
    hub,
    toolCatalog,
    logger: logger.child({ component: 'run-service' }),
  })

  const ctx: AppContext = {
    config,
    logger,
    db,
    repos: { users, agents, versions, sessions, messages, approvals, audit, mcp, runtimes },
    services: { agents: agentService, sessions: sessionService, runs: runService },
    hub,
    runtime,
    toolCatalog,
    probeMcp: probeMcpServer,
    startedAt: Date.now(),
  }

  repairAfterCrash(ctx)

  const app = await buildApp(ctx)
  runtime.startReaper()

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutting down', { reason })
    // 1) 结束所有 SSE（hijacked 连接不受 Fastify 管理）。
    hub.shutdown()
    // 2) 停止接受新请求；最多等 5s，避免 SSE 连接拖死退出。
    try {
      await Promise.race([app.close(), delay(5_000)])
    } catch (error) {
      logger.warn('http server close failed', error)
    }
    // 3) 逐个关闭运行时（并发 4 由 stopAll 内部保证）。
    await runtime.stopAll()
    // 4) 关闭数据库。
    db.close()
    logger.info('shutdown complete')
    process.exit(0)
  }

  process.once('SIGINT', () => {
    void shutdown('SIGINT').catch((error) => logger.error('shutdown failed', error))
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').catch((error) => logger.error('shutdown failed', error))
  })
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', reason)
  })
  process.on('uncaughtException', (error) => {
    logger.error('uncaught exception', error)
    void shutdown('uncaughtException')
  })

  await app.listen({ host: config.host, port: config.port })
  logger.info('agent gateway listening', {
    url: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
  })
}

function isEntry(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  return path.resolve(entry).toLowerCase() === SELF.toLowerCase()
}

if (isEntry()) {
  main().catch((error) => {
    // 启动失败必须非零退出，且不吞掉堆栈。
    process.stderr.write(`[gateway] fatal startup error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exit(1)
  })
}
