/**
 * 对话与项目配置的业务层：**配置快照的创建/冻结/校验**都只在这里发生。
 *
 * 关键规则（docs/SERVICE.md §2 / §7 / 硬要求 #2 #3）：
 * - 创建对话时算 `configKey` 并冻结快照；此后对话级配置只在 `messageCount === 0` 时可改；
 * - 未知技能 / MCP 服务器在"创建对话"和"改配置"时都校验 → 400 `SKILL_UNKNOWN` / `MCP_UNKNOWN`；
 * - 能力清单可以为空（没有技能目录、没有 MCP 配置文件都算合法状态）。
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type {
  AgentConfig,
  AgentConfigPatch,
  AgentConfigSnapshot,
  ConversationDto,
  ConversationSummary,
  CreateConversationRequest,
  McpServerDefinition,
  MessageDto,
  ProjectAgentConfigDto,
  ToolCallRecord,
} from '@agent-studio/shared'
import { agentConfigSchema, mergeAgentConfig, unique } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import { conversationRunning, conversationStarted, modelUnavailable, modelUnknown, notFound } from '../http/errors.js'
import type { ModelCatalogService } from '../models/ModelCatalogService.js'
import type { CapabilityRevision } from '../runtime/CapabilityRevision.js'
import type { McpConfig } from '../mcp/McpConfig.js'
import type { SkillSource } from '../skills/SkillSource.js'
import type { Store } from '../store/Store.js'
import type { MessageLog, MessageListResult } from '../store/MessageLog.js'
import { computeConfigKey } from '../runtime/ConfigKey.js'

/**
 * 默认能力配置（项目未保存、对话未继承时使用）。
 *
 * provider/model 留空：由 `ModelCatalogService` 从 DSH 的可用清单里选择默认项，
 * 这里**不写死**任何模型名。
 */
export function defaultAgentConfig(): AgentConfig {
  return agentConfigSchema.parse({
    skills: [],
    mcpServers: [],
    systemPrompt: '',
  })
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  const next: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) next[key] = entry
  }
  return next as Partial<T>
}

/** 首条用户消息 → 展示标题。 */
export function deriveTitle(content: string): string {
  const line = content.trim().split(/\r?\n/, 1)[0] ?? ''
  return line.length > 40 ? `${line.slice(0, 40)}…` : line
}

export interface ConversationServiceDeps {
  store: Store
  messages: MessageLog
  skills: SkillSource
  mcp: McpConfig
  /** 模型清单（权威来源是 DSH；这里只做默认值与校验）。 */
  models: ModelCatalogService
  /** 能力版本（技能内容 / MCP 定义 / profile 模板）。 */
  revision: CapabilityRevision
  logger: Logger
  now?: () => number
}

export class ConversationService {
  private readonly now: () => number

  constructor(private readonly deps: ConversationServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /* ------------------------------------------------------------- 校验 */

  /** 校验能力引用（未知技能/服务器直接抛 400），返回校验过的配置。 */
  private validate(config: AgentConfig): AgentConfig {
    this.deps.skills.locate(config.skills)
    this.deps.mcp.assertKnown(config.mcpServers)
    return config
  }

  /**
   * 决定并校验模型路由。
   *
   * 规则（"DSH 统一管理供应商与模型"的具体含义）：
   * 1. 配置里显式给了 provider/model → 必须在 **DSH 报告的清单** 里
   *    （否则 400 `MODEL_UNKNOWN`，附可用清单），来源记为 `user-selected`；
   * 2. 没给 → 用 DSH 的默认模型（`agent-default-model`）；
   * 3. DSH 默认模型在运行时不可用 → 503 `MODEL_UNAVAILABLE`（不悄悄换模型）。
   *
   * 也就是说：**清单与默认值由 DSH 决定，选择发生在 DSH 提供的集合内**。
   */
  private resolveRoute(config: AgentConfig): { config: AgentConfig; routeSource: AgentConfigSnapshot['routeSource'] } {
    const explicitProvider = config.provider.trim()
    const explicitModel = config.model.trim()
    if (explicitProvider.length > 0 || explicitModel.length > 0) {
      // 只给一侧时，另一侧用 DSH 默认补全，再整体校验（避免"半个路由"绕过校验）。
      const fallback = this.deps.models.defaultRouteStrict({
        unavailable: (message) => modelUnavailable(message),
      })
      const route = this.deps.models.requireRoute(
        explicitProvider.length > 0 ? explicitProvider : fallback.provider,
        explicitModel.length > 0 ? explicitModel : fallback.model,
        {
          unknown: (message, details) => modelUnknown(message, details),
          unavailable: (message) => modelUnavailable(message),
        },
      )
      return { config: { ...config, ...route }, routeSource: 'user-selected' }
    }
    const route = this.deps.models.defaultRouteStrict({
      unavailable: (message) => modelUnavailable(message),
    })
    return { config: { ...config, ...route }, routeSource: this.deps.models.lastDefaultSource() }
  }

  private snapshot(
    config: AgentConfig,
    projectId: string,
    inheritedFromProject: boolean,
    routeSource: AgentConfigSnapshot['routeSource'],
  ): AgentConfigSnapshot {
    const capabilityRevision = this.deps.revision.compute(config.skills, config.mcpServers)
    return {
      ...config,
      configKey: computeConfigKey({ ...config, capabilityRevision }),
      capabilityRevision,
      routeSource,
      projectId,
      createdAt: this.now(),
      inheritedFromProject,
    }
  }

  /* ------------------------------------------------------------- 项目配置 */

  getProjectConfig(projectId: string): ProjectAgentConfigDto {
    const record = this.deps.store.getProject(projectId)
    if (record === undefined) {
      // 未保存过：返回"DSH 默认路由 + 空能力"，前端可直接展示。
      return { ...this.resolveRoute(defaultAgentConfig()).config, projectId, saved: false }
    }
    return { ...record.config, projectId, saved: true, updatedAt: record.updatedAt }
  }

  /** body 为 patch：未提供的字段保持原值。 */
  updateProjectConfig(projectId: string, patch: AgentConfigPatch): ProjectAgentConfigDto {
    const base = this.deps.store.getProject(projectId)?.config ?? defaultAgentConfig()
    const merged = agentConfigSchema.parse({
      ...base,
      ...stripUndefined(patch as Record<string, unknown>),
    })
    // 只在"显式给了路由"时校验（并入 DSH 清单校验），但**不把默认路由写回项目配置**：
    // 项目没选就保持为空，这样对话创建时才能如实标记来源（catalog-first / dsh-default-model）。
    if (merged.provider.trim().length > 0 || merged.model.trim().length > 0) {
      this.resolveRoute(merged)
    }
    const next = this.validate(merged)
    const record = this.deps.store.saveProject(projectId, next)
    return { ...record.config, projectId, saved: true, updatedAt: record.updatedAt }
  }

  /* ------------------------------------------------------------- 对话 */

  list(options: { projectId?: string; limit?: number } = {}): ConversationSummary[] {
    return this.deps.store.listConversations(options)
  }

  getOrThrow(conversationId: string): ConversationDto {
    const record = this.deps.store.getConversation(conversationId)
    if (record === undefined) throw notFound(`对话不存在: ${conversationId}`)
    return record
  }

  create(input: CreateConversationRequest): ConversationDto {
    const inherit = input.inheritProjectConfig ?? true
    const project = inherit ? this.deps.store.getProject(input.projectId)?.config : undefined
    // provider/model 可选：给了就必须落在 DSH 清单内（resolveRoute 校验），
    // 没给则用 DSH 的默认模型。
    const override: AgentConfigPatch = stripUndefined({
      skills: input.skills,
      mcpServers: input.mcpServers,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.systemPrompt,
    })
    const resolved = this.resolveRoute(mergeAgentConfig(project, override, inherit))
    const merged = this.validate(resolved.config)
    const timestamp = this.now()

    const record: ConversationDto = {
      id: `conv-${randomUUID()}`,
      projectId: input.projectId,
      sessionId: `dsh-${randomBytes(16).toString('hex')}`,
      config: this.snapshot(merged, input.projectId, inherit && project !== undefined, resolved.routeSource),
      status: 'idle',
      title: input.title ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
      messageCount: 0,
    }
    this.deps.store.createConversation(record)
    this.deps.logger.info('conversation created', {
      conversationId: record.id,
      projectId: record.projectId,
      configKey: record.config.configKey,
      skills: record.config.skills,
      mcpServers: record.config.mcpServers,
    })
    return record
  }

  /** PUT /api/conversations/:id/config —— 仅当还没有消息时允许（否则 409 CONVERSATION_STARTED）。 */
  updateConfig(conversationId: string, patch: AgentConfigPatch): AgentConfigSnapshot {
    const record = this.getOrThrow(conversationId)
    if (record.messageCount > 0) throw conversationStarted()

    const current = record.config
    const resolvedConfig = this.resolveRoute(
      agentConfigSchema.parse({
        skills: patch.skills ?? current.skills,
        mcpServers: patch.mcpServers ?? current.mcpServers,
        provider: patch.provider ?? current.provider,
        model: patch.model ?? current.model,
        systemPrompt: patch.systemPrompt ?? current.systemPrompt,
      }),
    )
    const nextConfig = this.validate(resolvedConfig.config)

    const capabilityRevision = this.deps.revision.compute(nextConfig.skills, nextConfig.mcpServers)
    const snapshot: AgentConfigSnapshot = {
      ...nextConfig,
      configKey: computeConfigKey({ ...nextConfig, capabilityRevision }),
      capabilityRevision,
      routeSource: resolvedConfig.routeSource,
      projectId: current.projectId,
      createdAt: current.createdAt,
      inheritedFromProject: current.inheritedFromProject,
    }
    this.deps.store.updateConversation(conversationId, { config: snapshot, updatedAt: this.now() })
    this.deps.logger.info('conversation config updated', {
      conversationId,
      configKey: snapshot.configKey,
    })
    return snapshot
  }

  /** PATCH /api/conversations/:id —— 只改展示标题。 */
  rename(conversationId: string, title: string): ConversationDto {
    this.getOrThrow(conversationId)
    const updated = this.deps.store.updateConversation(conversationId, { title, updatedAt: this.now() })
    if (updated === undefined) throw notFound(`对话不存在: ${conversationId}`)
    this.deps.logger.info('conversation renamed', { conversationId })
    return updated
  }

  /** DELETE /api/conversations/:id —— 运行中不允许删除。 */
  remove(conversationId: string): void {
    const record = this.getOrThrow(conversationId)
    if (record.status === 'running') throw conversationRunning()
    this.deps.store.deleteConversation(conversationId)
    this.deps.messages.remove(conversationId)
    this.deps.logger.info('conversation deleted', { conversationId })
  }
  messages(conversationId: string): MessageListResult {
    this.getOrThrow(conversationId)
    return this.deps.messages.list(conversationId)
  }

  /**
   * 开始一轮：状态必须是 idle，落库用户消息并置 running。
   *
   * 同步执行（内存状态 + 同步原子写），因此"检查 running → 置 running"之间没有
   * 让第二个请求钻进来的 await 窗口。
   */
  beginTurn(conversationId: string, content: string): { conversation: ConversationDto; message: MessageDto } {
    const record = this.getOrThrow(conversationId)
    if (record.status === 'running') throw conversationRunning()

    const timestamp = this.now()
    const message: MessageDto = {
      id: `msg-${randomUUID()}`,
      conversationId,
      role: 'user',
      content,
      sequence: record.messageCount + 1,
      createdAt: timestamp,
    }
    this.deps.messages.append(message)

    const title = record.title.trim() === '' ? deriveTitle(content) : record.title
    const updated = this.deps.store.updateConversation(conversationId, {
      status: 'running',
      messageCount: record.messageCount + 1,
      updatedAt: timestamp,
      title,
      lastError: undefined,
    })
    if (updated === undefined) throw notFound(`对话不存在: ${conversationId}`)
    return { conversation: updated, message }
  }

  /* ------------------------------------------- RuntimeConversationSink 实现 */

  appendAssistant(conversationId: string, input: { text: string; toolCalls: ToolCallRecord[] }): MessageDto {
    const record = this.getOrThrow(conversationId)
    const timestamp = this.now()
    const message: MessageDto = {
      id: `msg-${randomUUID()}`,
      conversationId,
      role: 'assistant',
      content: input.text,
      sequence: record.messageCount + 1,
      createdAt: timestamp,
      ...(input.toolCalls.length === 0 ? {} : { toolCalls: input.toolCalls.map((call) => ({ ...call })) }),
    }
    this.deps.messages.append(message)
    this.deps.store.updateConversation(conversationId, {
      messageCount: record.messageCount + 1,
      updatedAt: timestamp,
    })
    return message
  }

  updateToolCalls(conversationId: string, messageId: string, toolCalls: ToolCallRecord[]): void {
    this.deps.messages.patch(conversationId, messageId, (message) => ({
      ...message,
      toolCalls: toolCalls.map((call) => ({ ...call })),
    }))
  }

  markIdle(conversationId: string): void {
    this.deps.store.updateConversation(conversationId, { status: 'idle', updatedAt: this.now() })
  }

  markFailed(conversationId: string, message: string): void {
    this.deps.store.updateConversation(conversationId, {
      status: 'failed',
      lastError: message,
      updatedAt: this.now(),
    })
  }

  /* ------------------------------------------------------------- 工具 */

  /** 校验一组技能名（供路由/测试复用）。 */
  assertSkills(names: readonly string[]): void {
    this.deps.skills.locate(unique(names))
  }

  /** 校验一组 MCP 服务器 id。 */
  assertMcpServers(ids: readonly string[]): McpServerDefinition[] {
    return this.deps.mcp.assertKnown(unique(ids))
  }
}
