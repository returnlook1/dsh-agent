/** 应用装配上下文：路由只依赖这个接口，方便测试替换。 */
import type { McpServerConfig } from '@agent-studio/shared'
import type { GatewayConfig } from './config.js'
import type { Logger } from './logger.js'
import type { GatewayDatabase } from './db/database.js'
import type { UsersRepository } from './repositories/users.js'
import type { AgentsRepository } from './repositories/agents.js'
import type { AgentVersionsRepository } from './repositories/agentVersions.js'
import type { SessionsRepository } from './repositories/sessions.js'
import type { MessagesRepository } from './repositories/messages.js'
import type { ApprovalsRepository } from './repositories/approvals.js'
import type { AuditRepository } from './repositories/audit.js'
import type { McpServersRepository } from './repositories/mcp.js'
import type { RuntimesRepository } from './repositories/runtimes.js'
import type { SseHub } from './runtime/SseHub.js'
import type { ToolCatalog } from './runtime/ToolCatalog.js'
import type { DshRuntimeManager } from './runtime/DshRuntimeManager.js'
import type { AgentService } from './services/AgentService.js'
import type { SessionService } from './services/SessionService.js'
import type { RunService } from './services/RunService.js'
import type { McpProbeOptions, McpProbeResult } from './runtime/McpProbe.js'

export interface AppRepositories {
  users: UsersRepository
  agents: AgentsRepository
  versions: AgentVersionsRepository
  sessions: SessionsRepository
  messages: MessagesRepository
  approvals: ApprovalsRepository
  audit: AuditRepository
  mcp: McpServersRepository
  runtimes: RuntimesRepository
}

export interface AppServices {
  agents: AgentService
  sessions: SessionService
  runs: RunService
}

export type McpProbeFn = (config: McpServerConfig, options?: McpProbeOptions) => Promise<McpProbeResult>

export interface AppContext {
  config: GatewayConfig
  logger: Logger
  db: GatewayDatabase
  repos: AppRepositories
  services: AppServices
  hub: SseHub
  runtime: DshRuntimeManager
  toolCatalog: ToolCatalog
  probeMcp: McpProbeFn
  startedAt: number
}
