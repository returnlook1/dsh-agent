/**
 * 启动装配：config → store/catalog/mcp → materializer/pool → routes → listen →
 * 优雅关闭（关 SSE → 停 HTTP → 关运行时）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { REPO_ROOT, describeConfig, loadConfig, type GatewayConfig } from './config.js'
import { createLogger, type Logger } from './logger.js'
import { McpConfig } from './mcp/McpConfig.js'
import { SnapshotMaterializer } from './runtime/SnapshotMaterializer.js'
import { RuntimePool, type RuntimeClientFactory } from './runtime/RuntimePool.js'
import { createHarnessRuntimeClient } from './runtime/HarnessRuntimeClient.js'
import { SseHub } from './runtime/SseHub.js'
import { ConversationService } from './service/Conversations.js'
import { SkillCatalog, type SkillRoot } from './skills/Catalog.js'
import { SkillSource } from './skills/SkillSource.js'
import { MessageLog } from './store/MessageLog.js'
import { Store } from './store/Store.js'
import type { AppContext } from './context.js'
import { buildApp } from './app.js'

const SELF = fileURLToPath(import.meta.url)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** SKILLS_DIRS → 带来源标签的技能根（第一个是项目目录，其余视为自定义目录）。 */
export function skillRoots(config: GatewayConfig): SkillRoot[] {
  return config.skillsDirs.map((dir, index) => ({ path: dir, source: index === 0 ? 'project' : 'custom' }))
}

/**
 * 构建全部服务（测试复用；`clientFactory` 用于注入假运行时，禁止单测 spawn DSH）。
 */
export function createServices(
  config: GatewayConfig,
  logger: Logger,
  options: { clientFactory?: RuntimeClientFactory } = {},
): AppContext {
  fs.mkdirSync(config.dataDir, { recursive: true })
  fs.mkdirSync(config.runtimeDir, { recursive: true })

  const store = new Store(path.join(config.dataDir, 'store.json'), logger.child({ component: 'store' }))
  store.init()
  const repaired = store.repairRunningConversations()
  if (repaired > 0) {
    logger.warn('repaired conversations left running by a previous process', { count: repaired })
  }
  const messageLog = new MessageLog(path.join(config.dataDir, 'conversations'), logger.child({ component: 'messages' }))
  messageLog.init()

  const catalog = new SkillCatalog({ roots: skillRoots(config), logger: logger.child({ component: 'skills' }) })
  const skills = new SkillSource(catalog, logger.child({ component: 'skills' }))
  const mcp = new McpConfig({
    configPath: config.mcpConfigPath,
    logger: logger.child({ component: 'mcp' }),
    repoRoot: REPO_ROOT,
  })
  const materializer = new SnapshotMaterializer({
    config,
    logger: logger.child({ component: 'materializer' }),
    skills,
    mcp,
  })
  const conversations = new ConversationService({
    store,
    messages: messageLog,
    skills,
    mcp,
    logger: logger.child({ component: 'conversations' }),
  })
  const hub = new SseHub(logger.child({ component: 'sse' }))
  const pool = new RuntimePool({
    config: {
      dshBin: config.dshBin,
      dshProfile: config.dshProfile,
      runtimeIdleMs: config.runtimeIdleMs,
      turnTimeoutMs: config.turnTimeoutMs,
      maxRuntimes: config.maxRuntimes,
    },
    logger: logger.child({ component: 'runtime-pool' }),
    materializer,
    hub,
    sink: conversations,
    clientFactory: options.clientFactory ?? createHarnessRuntimeClient,
  })

  return {
    config,
    logger,
    store,
    messageLog,
    catalog,
    skills,
    mcp,
    conversations,
    pool,
    hub,
    startedAt: Date.now(),
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const logger = createLogger(config.logLevel).child({ component: 'agent-service' })
  logger.info('starting DSH agent service', describeConfig(config))

  const ctx = createServices(config, logger)
  const app = await buildApp(ctx)
  ctx.pool.startReaper()

  let shuttingDown = false
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    logger.info('shutting down', { reason })
    // 1) 结束所有 SSE（hijacked 连接不受 Fastify 管理）。
    ctx.hub.shutdown()
    // 2) 停止接受新请求；最多等 5s，避免 SSE 连接拖死退出。
    try {
      await Promise.race([app.close(), delay(5_000)])
    } catch (error) {
      logger.warn('http server close failed', error)
    }
    // 3) 关闭全部运行时（优雅走 SDK 的 shutdown → EOF → SIGTERM 阶梯）。
    await ctx.pool.closeAll().catch((error) => logger.warn('closing runtimes failed', error))
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
  logger.info('dsh agent service listening', {
    url: `http://${config.host}:${config.port}`,
    dataDir: config.dataDir,
    runtimeDir: config.runtimeDir,
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
    process.stderr.write(
      `[agent-service] fatal startup error: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
    )
    process.exit(1)
  })
}
