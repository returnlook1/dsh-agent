/**
 * Agent 生命周期：创建/更新/发布/禁用/启用 + 发布校验。
 *
 * 发布校验的原则（docs/DECISIONS.md §6）：配置项必须真的能落实；不能落实的
 * 变为 warning 返回，安全相关或无法落实的硬错误直接拒绝发布。
 */
import { randomUUID } from 'node:crypto'
import {
  agentConfigSchema,
  mergeAgentConfig,
  slugifyAgentId,
  type AgentConfig,
  type AgentDetail,
  type AgentSummary,
  type AgentToolsResponse,
  type AgentVersionDto,
  type ConfigWarning,
  type CreateAgentRequest,
  type McpServerDto,
  type ToolAction,
  type ToolDescriptor,
  type UpdateAgentRequest,
  type UserDto,
} from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { GatewayDatabase } from '../db/database.js'
import type { AgentsRepository, AgentRecord } from '../repositories/agents.js'
import type { AgentVersionsRepository } from '../repositories/agentVersions.js'
import type { McpServersRepository } from '../repositories/mcp.js'
import { conflict, forbidden, notFound, validationError, ApiError } from '../http/errors.js'
import type { GatewayConfig } from '../config.js'
import type { RuntimeMaterializer } from '../runtime/RuntimeMaterializer.js'
import type { ProfileValidator } from '../runtime/ProfileValidator.js'
import { buildPolicy } from '../runtime/PolicyBuilder.js'
import type { ToolCatalog } from '../runtime/ToolCatalog.js'

export interface AgentServiceDeps {
  config: GatewayConfig
  db: GatewayDatabase
  agents: AgentsRepository
  versions: AgentVersionsRepository
  mcpServers: McpServersRepository
  toolCatalog: ToolCatalog
  materializer: RuntimeMaterializer
  profileValidator: ProfileValidator
  logger: Logger
}

export class AgentService {
  constructor(private readonly deps: AgentServiceDeps) {}

  private canSeeDraft(record: AgentRecord, user: UserDto): boolean {
    return user.role === 'admin' || record.ownerId === user.id
  }

  list(user: UserDto): AgentSummary[] {
    return this.deps.agents.listForUser(user.id, user.role).map((record) => this.deps.agents.toSummary(record))
  }

  get(id: string, user: UserDto): AgentDetail {
    const record = this.deps.agents.getById(id)
    if (record === undefined) throw notFound(`Agent 不存在: ${id}`)
    if (user.role !== 'admin') {
      if (record.status !== 'published' && record.ownerId !== user.id) {
        throw notFound(`Agent 不存在: ${id}`)
      }
    }
    return this.deps.agents.toDetail(record)
  }

  create(input: CreateAgentRequest, user: UserDto): AgentDetail {
    const id = input.id ?? slugifyAgentId(input.name)
    if (this.deps.agents.exists(id)) throw conflict(`Agent id 已存在: ${id}`)
    const draft = agentConfigSchema.parse({
      ...input,
      id,
      status: 'draft',
      version: 1,
    })
    const record = this.deps.agents.insert({
      id,
      name: draft.name,
      description: draft.description,
      status: 'draft',
      ownerId: user.id,
      currentVersion: 0,
      draft,
    })
    return this.deps.agents.toDetail(record)
  }

  update(id: string, patch: UpdateAgentRequest, user: UserDto): AgentDetail {
    const record = this.deps.agents.getById(id)
    if (record === undefined) throw notFound(`Agent 不存在: ${id}`)
    if (user.role !== 'admin' && record.ownerId !== user.id) throw forbidden('只有管理员可以修改 Agent')

    const merged = mergeAgentConfig(record.draft, patch)
    const draft = agentConfigSchema.parse({ ...merged, id, status: record.status })
    const updated = this.deps.agents.updateDraft(id, {
      draft,
      name: draft.name,
      description: draft.description,
    })
    if (updated === undefined) throw notFound(`Agent 不存在: ${id}`)
    return this.deps.agents.toDetail(updated)
  }

  /**
   * 发布：生成不可变版本 + 工具授权 + warnings，并做一次运行时配置树检查。
   * 校验失败时版本不落库（409 RUNTIME_ERROR / 400 VALIDATION_ERROR）。
   */
  async publish(id: string, user: UserDto): Promise<AgentVersionDto> {
    const record = this.deps.agents.getById(id)
    if (record === undefined) throw notFound(`Agent 不存在: ${id}`)
    if (user.role !== 'admin') throw forbidden('只有管理员可以发布 Agent')

    const warnings: ConfigWarning[] = []
    const errors: string[] = []
    const config: AgentConfig = structuredClone(record.draft)

    if (config.prompt.system.trim() === '') errors.push('prompt.system 不能为空')
    if (config.model.provider.trim() === '') errors.push('model.provider 不能为空')
    if (config.model.modelId.trim() === '') errors.push('model.modelId 不能为空')
    if (config.capabilities.subagents) errors.push('capabilities.subagents 必须为 false')

    for (const field of ['shell', 'fileRead', 'fileWrite', 'pluginManagement'] as const) {
      if (config.security[field]) errors.push(`security.${field} 必须为 false（受限运行时移除了该能力）`)
    }

    // 工具授权：未知工具拒绝；ask 无审批通道时降级 deny。
    for (const [name, action] of Object.entries(config.capabilities.tools)) {
      if (!this.deps.toolCatalog.isKnown(name)) {
        errors.push(`capabilities.tools 含未知工具: ${name}`)
        continue
      }
      if (action === 'ask' && !this.deps.toolCatalog.supportsApprovalChannel(name)) {
        warnings.push({
          field: `capabilities.tools.${name}`,
          message: `工具 ${name} 没有审批通道，ask 已降级为 deny`,
        })
        config.capabilities.tools[name] = 'deny'
      }
    }

    for (const serverId of config.capabilities.mcpServers) {
      const server = this.deps.mcpServers.get(serverId)
      if (server === undefined) {
        errors.push(`capabilities.mcpServers 含不存在的服务器: ${serverId}`)
        continue
      }
      if (!server.enabled) errors.push(`capabilities.mcpServers 含已禁用的服务器: ${serverId}`)
    }
    if (config.security.networkAccess === 'none' && config.capabilities.mcpServers.length > 0) {
      warnings.push({
        field: 'security.networkAccess',
        message: 'networkAccess=none 时不会挂载任何 MCP 服务器',
      })
    }

    if (config.model.temperature !== undefined) {
      warnings.push({
        field: 'model.temperature',
        message: '当前 DSH SDK initialize 不携带 temperature；该配置仅保存，不保证生效',
      })
    }
    if (config.security.networkAccess === 'allowlist') {
      warnings.push({
        field: 'security.networkAccess',
        message: 'allowlist 尚未实现，运行时按 restricted 处理',
      })
    }
    if (config.capabilities.skills.length > 0) {
      warnings.push({
        field: 'capabilities.skills',
        message: '受限 profile 未挂载 skill 插件；skills 配置暂不生效',
      })
    }
    if (config.ui.allowAttachments) {
      warnings.push({
        field: 'ui.allowAttachments',
        message: '网关尚未实现附件上传；该配置仅供前端展示',
      })
    }

    if (errors.length > 0) throw validationError('发布校验失败', { errors })

    const version = this.deps.versions.nextVersion(id)
    config.version = version

    // 运行时配置树检查：物化 profile + --dump-config。
    const validationRuntimeId = `validate-${id}-v${version}-${randomUUID().slice(0, 8)}`
    const authorizedMcpServers = config.capabilities.mcpServers
      .map((serverId) => this.deps.mcpServers.get(serverId))
      .filter((server): server is McpServerDto => server !== undefined && server.enabled)
    const materialized = this.deps.materializer.materialize({
      runtimeId: validationRuntimeId,
      sessionId: 'publish-check',
      userId: user.id,
      agentId: id,
      agentVersion: version,
      config,
      mcpServers: authorizedMcpServers,
    })
    try {
      const policy = buildPolicy({
        config,
        agentVersion: version,
        runtimeId: validationRuntimeId,
        sessionId: 'publish-check',
        userId: user.id,
        controlDir: materialized.controlDir,
        auditPath: materialized.auditPath,
        approvalTimeoutMs: this.deps.config.approvalTimeoutMs,
        toolLookup: this.deps.toolCatalog,
      })
      warnings.push(...policy.warnings)
      this.deps.materializer.writePolicySnapshot(materialized, policy.snapshot)
    } catch (error) {
      throw new ApiError(
        'RUNTIME_ERROR',
        `策略快照生成失败: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        409,
      )
    }

    const validation = await this.deps.profileValidator.validate(materialized)
    if (!validation.ok) {
      this.deps.logger.error('publish runtime validation failed', {
        agentId: id,
        version,
        error: validation.error,
      })
      throw new ApiError(
        'RUNTIME_ERROR',
        `运行时配置校验失败: ${validation.error ?? 'unknown error'}`,
        { output: validation.output?.slice(0, 4000) },
        409,
      )
    }

    this.deps.db.transaction(() => {
      this.deps.versions.insert({
        agentId: id,
        version,
        config,
        createdBy: user.id,
        verified: true,
        warnings,
      })
      this.deps.versions.replacePermissions(id, version, config.capabilities.tools)
      this.deps.agents.setCurrentVersion(id, version)
      this.deps.agents.setStatus(id, 'published')
    })

    const published = this.deps.versions.get(id, version)
    if (published === undefined) throw new Error('agent version vanished after publish')
    return published
  }

  setEnabled(id: string, enabled: boolean, _user: UserDto): AgentDetail {
    const record = this.deps.agents.getById(id)
    if (record === undefined) throw notFound(`Agent 不存在: ${id}`)
    if (enabled && record.currentVersion <= 0) throw conflict('尚未发布任何版本，无法启用')
    this.deps.agents.setStatus(id, enabled ? 'published' : 'disabled')
    const updated = this.deps.agents.getById(id)
    if (updated === undefined) throw notFound(`Agent 不存在: ${id}`)
    return this.deps.agents.toDetail(updated)
  }

  tools(id: string, user: UserDto): AgentToolsResponse {
    const record = this.deps.agents.getById(id)
    if (record === undefined) throw notFound(`Agent 不存在: ${id}`)
    if (user.role !== 'admin' && record.status !== 'published' && record.ownerId !== user.id) {
      throw notFound(`Agent 不存在: ${id}`)
    }

    const version = record.currentVersion > 0 ? record.currentVersion : 0
    const permissions: Record<string, ToolAction> =
      version > 0 ? this.deps.versions.listPermissions(id, version) : record.draft.capabilities.tools

    const resolve = (name: string): ToolAction => {
      const direct = permissions[name]
      if (direct !== undefined) return direct
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        const wildcard = `${parts[0]}__${parts[1]}__*`
        return permissions[wildcard] ?? 'deny'
      }
      return 'deny'
    }

    return {
      agentId: id,
      version,
      tools: this.deps.toolCatalog.descriptors().map((descriptor) => ({
        ...descriptor,
        action: resolve(descriptor.name),
      })),
      blockedCapabilities: this.deps.toolCatalog.blockedCapabilities(),
    }
  }

  catalog(): { total: number; items: ToolDescriptor[] } {
    const items = this.deps.toolCatalog.descriptors()
    return { total: items.length, items }
  }
}
