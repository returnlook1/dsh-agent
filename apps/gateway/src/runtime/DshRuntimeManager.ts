/**
 * 运行时管理器：每个业务会话一个 DSH 子进程（第一版不做池化）。
 *
 * 职责边界：
 * - 物化目录/策略 → SDK 启动参数 → 生命周期（ensure / prompt / stop / reap）；
 * - 通知经 `DshEventAdapter` 映射，审批经 `ApprovalBridge`，审计经 `AuditTailer`；
 * - 路由层永远不直接 new SDK 对象。
 */
import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentConfig,
  ApprovalDecision,
  PolicySnapshot,
  RuntimeStatusDto,
  ToolRisk,
} from '@agent-studio/shared'
import type { SessionRow } from '../db/types.js'
import type { Logger } from '../logger.js'
import type { ApprovalsRepository } from '../repositories/approvals.js'
import type { AgentVersionsRepository } from '../repositories/agentVersions.js'
import type { AuditRepository } from '../repositories/audit.js'
import type { McpServersRepository } from '../repositories/mcp.js'
import type { RuntimesRepository } from '../repositories/runtimes.js'
import type { MessagesRepository } from '../repositories/messages.js'
import type { SessionsRepository } from '../repositories/sessions.js'
import type { GatewayConfig } from '../config.js'
import { buildPolicy, type PolicyToolLookup } from './PolicyBuilder.js'
import { DshEventAdapter } from './DshEventAdapter.js'
import { ApprovalBridge } from './ApprovalBridge.js'
import { AuditTailer } from './AuditTailer.js'
import { RuntimeMaterializer, type MaterializedRuntime } from './RuntimeMaterializer.js'
import type { SseHub } from './SseHub.js'

/* ------------------------------------------------------------------ SDK 抽象 */

export interface NotificationLike {
  method: string
  params: Record<string, unknown>
}

export interface SubscriptionLike {
  next(): Promise<NotificationLike>
  tryNext(): NotificationLike | undefined
  close(): void
}

export interface HarnessClientLike {
  start(): void
  initialize(params: {
    cwd: string
    provider: string
    model: string
    reasoningEffort?: string
    maxTokens?: number
  }): Promise<{ serverInfo: { name: string; version: string } }>
  prompt(sessionId: string, contentBlocks: Array<{ type: 'text'; text: string }>): Promise<string>
  resumeSession(sessionId: string): Promise<void>
  subscribe(filter?: (notification: NotificationLike) => boolean): SubscriptionLike
  close(): Promise<void>
}

export interface RuntimeClientOptions {
  dshBin: string
  profile: string
  dshHome: string
  patches: string[]
  processCwd: string
  cwd: string
  provider: string
  model: string
  maxTokens?: number
  reasoningEffort?: string
  initializeTimeoutMs: number
  env: NodeJS.ProcessEnv
}

export type HarnessClientFactory = (options: RuntimeClientOptions) => Promise<HarnessClientLike>

const defaultFactory: HarnessClientFactory = async (options) => {
  const { HarnessClient } = await import('@deepseek-ai/dsh-sdk-client')
  const client = new HarnessClient({
    dshBin: options.dshBin,
    profile: options.profile,
    dshHome: options.dshHome,
    patches: options.patches,
    processCwd: options.processCwd,
    env: options.env,
    initializeTimeoutMs: options.initializeTimeoutMs,
    // 不设置 requestTimeoutMs：一个 turn 可能合法地跑很久，兜底由停止/回收负责。
  })
  return client as unknown as HarnessClientLike
}

/* ------------------------------------------------------------------ 输入输出 */

export interface EnsureRuntimeInput {
  session: SessionRow
  toolLookup: PolicyToolLookup & { riskFor(name: string): ToolRisk | undefined }
}

export interface RuntimeSessionInfo {
  runtimeId: string
  dshSessionId: string
}

export interface ApprovalDecisionResult {
  ok: boolean
  status: 'allowed' | 'rejected' | 'cancelled' | 'expired' | 'pending' | 'missing'
}

interface LiveRuntime {
  runtimeId: string
  sessionId: string
  agentId: string
  agentVersion: number
  policyVersion: number
  startedAt: number
  dshSessionId: string
  client: HarnessClientLike
  subscription: SubscriptionLike
  adapter: DshEventAdapter
  bridge: ApprovalBridge
  tailer: AuditTailer
  materialized: MaterializedRuntime
  status: RuntimeStatusDto['status']
  lastActivityAt: number
  stopping?: Promise<void>
}

export interface RuntimeManagerDeps {
  config: GatewayConfig
  logger: Logger
  sessions: SessionsRepository
  messages: MessagesRepository
  versions: AgentVersionsRepository
  approvals: ApprovalsRepository
  audit: AuditRepository
  mcp: McpServersRepository
  runtimes: RuntimesRepository
  hub: SseHub
  materializer: RuntimeMaterializer
  clientFactory?: HarnessClientFactory
  now?: () => number
}

export class DshRuntimeManager {
  private readonly live = new Map<string, LiveRuntime>()
  private readonly clientFactory: HarnessClientFactory
  private readonly now: () => number
  private reaperTimer: NodeJS.Timeout | undefined
  private shuttingDown = false

  constructor(private readonly deps: RuntimeManagerDeps) {
    this.clientFactory = deps.clientFactory ?? defaultFactory
    this.now = deps.now ?? (() => Date.now())
  }

  startReaper(): void {
    if (this.reaperTimer !== undefined) return
    this.reaperTimer = setInterval(() => {
      this.reap().catch((error) => this.deps.logger.error('runtime reap failed', error))
    }, Math.min(60_000, Math.max(5_000, Math.floor(this.deps.config.runtimeIdleMs / 4))))
    this.reaperTimer.unref()
  }

  /** 空闲回收：只在没有进行中的 turn 时关闭运行时。 */
  async reap(): Promise<void> {
    if (this.shuttingDown) return
    const now = this.now()
    const stale: string[] = []
    for (const runtime of this.live.values()) {
      if (runtime.adapter.hasActiveRun()) continue
      if (now - runtime.lastActivityAt >= this.deps.config.runtimeIdleMs) stale.push(runtime.sessionId)
    }
    for (const sessionId of stale) {
      this.deps.logger.info('reaping idle runtime', { sessionId })
      await this.stopSession(sessionId, '空闲回收').catch((error) =>
        this.deps.logger.warn('failed to reap runtime', { sessionId, error }),
      )
    }
  }

  hasRuntime(sessionId: string): boolean {
    return this.live.has(sessionId)
  }

  async ensure(input: EnsureRuntimeInput): Promise<RuntimeSessionInfo> {
    const existing = this.live.get(input.session.id)
    if (existing !== undefined) {
      existing.lastActivityAt = this.now()
      return { runtimeId: existing.runtimeId, dshSessionId: existing.dshSessionId }
    }

    const config = this.publishedConfig(input.session)
    // runtimeId 与业务会话绑定（稳定），这样空闲回收/网关重启后能复用同一个
    // DSH_HOME 与 workspace：SDK resume 依赖 $DSH_HOME/sessions 下的会话日志。
    const runtimeId = `rt-${createHash('sha256').update(input.session.id).digest('hex').slice(0, 24)}`
    const dshSessionId = input.session.dsh_session_id ?? `s-${randomUUID()}`
    const authorizedMcpServers = config.capabilities.mcpServers
      .map((serverId) => this.deps.mcp.get(serverId))
      .filter((server): server is NonNullable<typeof server> => server !== undefined && server.enabled)
    const materialized = this.deps.materializer.materialize({
      runtimeId,
      sessionId: input.session.id,
      userId: input.session.user_id,
      agentId: input.session.agent_id,
      agentVersion: Number(input.session.agent_version),
      config,
      mcpServers: authorizedMcpServers,
    })

    const builtPolicy = this.buildPolicyFor(input, config, materialized, runtimeId)
    const policy = this.deps.materializer.writePolicySnapshot(materialized, builtPolicy)

    this.deps.runtimes.insert({
      id: runtimeId,
      agentId: input.session.agent_id,
      agentVersion: Number(input.session.agent_version),
      sessionId: input.session.id,
      profile: this.deps.config.dshProfile,
      home: materialized.homeDir,
      workspace: materialized.workspaceDir,
      policyVersion: policy.agentVersion,
    })

    const adapter = new DshEventAdapter({
      sessionId: input.session.id,
      userId: input.session.user_id,
      runtimeId,
      agentId: input.session.agent_id,
      agentVersion: Number(input.session.agent_version),
      dshSessionId,
      maxTurns: config.limits.maxTurns,
      hub: this.deps.hub,
      sessions: this.deps.sessions,
      messages: this.deps.messages,
      logger: this.deps.logger.child({ runtimeId }),
      toolLookup: input.toolLookup,
      onMaxTurns: () => {
        // 超过 maxTurns：关闭运行时（不等待 turn 结束，SDK 无中途取消）。
        void this.stopSession(input.session.id, '超过 maxTurns').catch((error) =>
          this.deps.logger.warn('failed to stop runtime after max turns', { sessionId: input.session.id, error }),
        )
      },
      onTerminal: () => {
        const runtime = this.live.get(input.session.id)
        if (runtime !== undefined) runtime.lastActivityAt = this.now()
      },
    })

    const bridge = new ApprovalBridge({
      controlDir: materialized.controlDir,
      sessionId: input.session.id,
      runtimeId,
      userId: input.session.user_id,
      approvalTimeoutMs: this.deps.config.approvalTimeoutMs,
      approvals: this.deps.approvals,
      hub: this.deps.hub,
      logger: this.deps.logger.child({ runtimeId, component: 'approval' }),
    })
    bridge.start()

    const tailer = new AuditTailer({
      auditPath: materialized.auditPath,
      runtimeId,
      audit: this.deps.audit,
      logger: this.deps.logger.child({ runtimeId, component: 'audit' }),
    })
    tailer.start()

    const options: RuntimeClientOptions = {
      dshBin: this.deps.config.dshBin,
      profile: this.deps.config.dshProfile,
      dshHome: materialized.homeDir,
      // profile 的 cordis.patch.yml 由 DSH boot 自动加载；这里只叠加可选 mock-LLM patch。
      patches: materialized.patches,
      processCwd: materialized.workspaceDir,
      cwd: materialized.workspaceDir,
      provider: config.model.provider,
      model: config.model.modelId,
      initializeTimeoutMs: 20_000,
      env: materialized.env,
    }
    if (config.model.maxOutputTokens !== undefined) options.maxTokens = config.model.maxOutputTokens
    if (config.model.reasoningEffort !== undefined) options.reasoningEffort = config.model.reasoningEffort

    let client: HarnessClientLike | undefined
    try {
      client = await this.clientFactory(options)
      client.start()
      await client.initialize({
        cwd: materialized.workspaceDir,
        provider: config.model.provider,
        model: config.model.modelId,
        ...(config.model.maxOutputTokens === undefined ? {} : { maxTokens: config.model.maxOutputTokens }),
        ...(config.model.reasoningEffort === undefined ? {} : { reasoningEffort: config.model.reasoningEffort }),
      })
      if (input.session.dsh_session_id !== null) {
        // 恢复历史必须真的 resume；失败时 fail closed，不静默创建新会话。
        await client.resumeSession(input.session.dsh_session_id)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.error('failed to start runtime', { sessionId: input.session.id, runtimeId, error })
      this.deps.runtimes.setStatus(runtimeId, 'failed', message)
      bridge.stop()
      tailer.stop()
      if (client !== undefined) {
        await client.close().catch(() => undefined)
      }
      adapter.failRun(`运行时启动失败: ${message}`, 'runtime-start-failed')
      throw error
    }

    // 先订阅再 prompt（官方要求；反过来可能丢回执）。
    const subscription = client.subscribe(
      (notification) => notification.params.sessionId === dshSessionId,
    )

    const runtime: LiveRuntime = {
      runtimeId,
      sessionId: input.session.id,
      agentId: input.session.agent_id,
      agentVersion: Number(input.session.agent_version),
      policyVersion: policy.agentVersion,
      startedAt: this.now(),
      dshSessionId,
      client,
      subscription,
      adapter,
      bridge,
      tailer,
      materialized,
      status: 'ready',
      lastActivityAt: this.now(),
    }
    this.live.set(input.session.id, runtime)
    this.deps.runtimes.setStatus(runtimeId, 'ready')
    this.deps.sessions.setRuntime(input.session.id, runtimeId, dshSessionId)

    // 通知泵：任何终止/异常都要接住，不能产生 unhandled rejection。
    void this.pump(runtime)
    return { runtimeId, dshSessionId }
  }

  private async pump(runtime: LiveRuntime): Promise<void> {
    try {
      for (;;) {
        const notification = await runtime.subscription.next()
        runtime.adapter.handleNotification(notification)
      }
    } catch (error) {
      runtime.adapter.handleTransportClosed(error)
      this.deps.runtimes.setStatus(runtime.runtimeId, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  private publishedConfig(session: SessionRow): AgentConfig {
    const version = this.deps.versions.get(session.agent_id, Number(session.agent_version))
    if (version === undefined) {
      throw new Error(`agent version not found: ${session.agent_id}@${session.agent_version}`)
    }
    return version.config
  }

  private buildPolicyFor(
    input: EnsureRuntimeInput,
    config: AgentConfig,
    materialized: MaterializedRuntime,
    runtimeId: string,
  ): PolicySnapshot {
    const result = buildPolicy({
      config,
      agentVersion: Number(input.session.agent_version),
      runtimeId,
      sessionId: input.session.id,
      userId: input.session.user_id,
      controlDir: materialized.controlDir,
      auditPath: materialized.auditPath,
      approvalTimeoutMs: this.deps.config.approvalTimeoutMs,
      toolLookup: input.toolLookup,
    })
    if (result.warnings.length > 0) {
      this.deps.logger.warn('policy downgraded tools at runtime', { warnings: result.warnings })
    }
    return result.snapshot
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const runtime = this.live.get(sessionId)
    if (runtime === undefined) throw new Error(`runtime not started for session ${sessionId}`)
    if (runtime.status === 'failed') throw new Error('runtime is not healthy')
    runtime.status = 'busy'
    runtime.lastActivityAt = this.now()
    this.deps.runtimes.setStatus(runtime.runtimeId, 'busy')
    runtime.adapter.beginRun()
    try {
      await runtime.client.prompt(runtime.dshSessionId, [{ type: 'text', text }])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      runtime.adapter.failRun(`发送消息失败: ${message}`, 'prompt-failed')
      runtime.status = 'failed'
      this.deps.runtimes.setStatus(runtime.runtimeId, 'failed', message)
      throw error
    } finally {
      runtime.lastActivityAt = this.now()
      if (runtime.status === 'busy') runtime.status = 'ready'
    }
  }

  async stopSession(sessionId: string, reason = '已停止'): Promise<void> {
    const runtime = this.live.get(sessionId)
    if (runtime === undefined) {
      this.deps.sessions.clearRuntime(sessionId)
      return
    }
    if (runtime.stopping !== undefined) return runtime.stopping

    runtime.stopping = (async () => {
      // 若还有进行中的 turn，先保证 SSE 收到终止事件。
      runtime.adapter.abortRun(reason)
      // 关闭运行时后审批无法再送达：全部按拒绝处理。
      runtime.bridge.expirePending(reason)
      runtime.bridge.stop()
      runtime.tailer.stop()
      try {
        runtime.subscription.close()
      } catch {
        // 订阅可能已失效。
      }
      try {
        await runtime.client.close()
      } catch (error) {
        this.deps.logger.warn('runtime close failed', { sessionId, error })
      }
      this.deps.runtimes.setStatus(runtime.runtimeId, 'stopped')
      this.deps.sessions.clearRuntime(sessionId)
      this.deps.sessions.updateStatus(sessionId, 'idle')
      this.live.delete(sessionId)
    })()

    try {
      await runtime.stopping
    } finally {
      runtime.stopping = undefined
    }
  }

  /** 优雅退出：并发上限 4。 */
  async stopAll(): Promise<void> {
    this.shuttingDown = true
    if (this.reaperTimer !== undefined) clearInterval(this.reaperTimer)
    this.reaperTimer = undefined
    const sessionIds = [...this.live.keys()]
    const concurrency = 4
    for (let index = 0; index < sessionIds.length; index += concurrency) {
      const batch = sessionIds.slice(index, index + concurrency)
      await Promise.all(
        batch.map((sessionId) =>
          this.stopSession(sessionId, '网关关闭').catch((error) =>
            this.deps.logger.warn('failed to stop runtime during shutdown', { sessionId, error }),
          ),
        ),
      )
    }
  }

  status(): RuntimeStatusDto[] {
    return [...this.live.values()].map((runtime) => {
      const dto: RuntimeStatusDto = {
        runtimeId: runtime.runtimeId,
        agentId: runtime.agentId,
        agentVersion: runtime.agentVersion,
        status: runtime.status,
        policyVersion: runtime.policyVersion,
        startedAt: runtime.startedAt,
      }
      return dto
    })
  }

  /** 审批决定：只有运行中的 bridge 能写决定文件；否则 fail closed。 */
  decideApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    decidedBy: string,
    reason?: string,
  ): ApprovalDecisionResult {
    const runtime = this.live.get(sessionId)
    if (runtime === undefined) return { ok: false, status: 'missing' }
    return runtime.bridge.decide(approvalId, decision, decidedBy, reason)
  }

  /** 供测试/维护使用：当前运行时的物化信息。 */
  runtimeInfo(sessionId: string): { runtimeId: string; homeDir: string; workspaceDir: string } | undefined {
    const runtime = this.live.get(sessionId)
    if (runtime === undefined) return undefined
    return {
      runtimeId: runtime.runtimeId,
      homeDir: runtime.materialized.homeDir,
      workspaceDir: runtime.materialized.workspaceDir,
    }
  }
}
