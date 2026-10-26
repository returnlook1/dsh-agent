/**
 * 装配上下文：所有模块只通过它拿依赖（便于测试注入假运行时）。
 */
import type { GatewayConfig } from './config.js'
import type { Logger } from './logger.js'
import type { McpConfig } from './mcp/McpConfig.js'
import type { RuntimePool } from './runtime/RuntimePool.js'
import type { SseHub } from './runtime/SseHub.js'
import type { ConversationService } from './service/Conversations.js'
import type { SkillCatalog } from './skills/Catalog.js'
import type { SkillSource } from './skills/SkillSource.js'
import type { MessageLog } from './store/MessageLog.js'
import type { Store } from './store/Store.js'

export interface AppContext {
  config: GatewayConfig
  logger: Logger
  store: Store
  messageLog: MessageLog
  catalog: SkillCatalog
  skills: SkillSource
  mcp: McpConfig
  conversations: ConversationService
  pool: RuntimePool
  hub: SseHub
  startedAt: number
}
