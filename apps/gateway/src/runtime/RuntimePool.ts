/**
 * 运行时池（docs/SERVICE.md §5）。
 *
 * | 关注点 | 规则 |
 * | --- | --- |
 * | 复用键 | `configKey`（同指纹共享同一个 DSH 运行时） |
 * | 承载 | 一个运行时承载多个会话（每个对话一个 DSH session） |
 * | 恢复 | 运行时被回收后重建（同 home），对已有 sessionId 先 `resumeSession()` 再 `prompt()` |
 * | 事件路由 | 一个订阅，按 `notification.params.sessionId` → `conversationId` 反查 |
 * | 空闲回收 | 每 30s 扫描，`now - lastActiveAt > RUNTIME_IDLE_MS` 且无运行中对话 → close() |
 * | 失败处理 | 传输错误 → 该运行时上所有运行中对话收到 `message.failed`，实例销毁 |
 * | 上限 | `MAX_RUNTIMES`：超出先回收最久空闲的；无空闲可回收 → 503 |
 *
 * 单元测试不能启动真实 DSH：客户端由 `clientFactory` 注入（生产见 `HarnessRuntimeClient.ts`）。
 */
import type { AgentConfigSnapshot, MessageDto, RuntimeInfo, ToolCallRecord } from '@agent-studio/shared'
import type { HarnessNotification } from '@deepseek-ai/dsh-sdk-client'
import type { Logger } from '../logger.js'
import { ApiError, conversationRunning } from '../http/errors.js'
import type { MaterializedSnapshot, SnapshotMaterializer } from './SnapshotMaterializer.js'
import { TurnEventAdapter, type TurnOutcome } from './TurnEventAdapter.js'
import type { SseHub } from './SseHub.js'

/* ------------------------------------------------------------------ 客户端抽象 */

export interface NotificationSubscriptionLike {
  next(): Promise<HarnessNotification>
  close(): void
}

/** `HarnessClient` 的最小可用子集（测试注入假实现）。 */
export interface RuntimeClient {
  start(): void
  initialize(params: { cwd: string; provider: string; model: string }): Promise<unknown>
  prompt(sessionId: string, contentBlocks: Array<{ type: 'text'; text: string }>): Promise<string>
  resumeSession(sessionId: string): Promise<void>
  subscribe(filter?: (notification: HarnessNotification) => boolean): NotificationSubscriptionLike
  close(): Promise<void>
}

export interface RuntimeClientOptions {
  dshBin: string
  profile: string
  dshHome: string
  processCwd: string
  patches: string[]
  env: NodeJS.ProcessEnv
}

export type RuntimeClientFactory = (options: RuntimeClientOptions) => RuntimeClient

/* ------------------------------------------------------------------ 输入/输出 */

/** 对话存储侧的回调（由 ConversationService 实现）。 */
export interface RuntimeConversationSink {
  markIdle(conversationId: string): void
  markFailed(conversationId: string, message: string): void
  appendAssistant(conversationId: string, input: { text: string; toolCalls: ToolCallRecord[] }): MessageDto
  updateToolCalls(conversationId: string, messageId: string, toolCalls: ToolCallRecord[]): void
}

export interface SendTurnInput {
  conversationId: string
  sessionId: string
  config: AgentConfigSnapshot
  text: string
  /** 此前是否已有消息：决定运行时重建后是否需要先 resume。 */
  hasHistory: boolean
}

export interface SendTurnResult {
  outcome: TurnOutcome
  runtimeId: string
  error?: string
}

interface RuntimeEntry {
  runtimeId: string
  configKey: string
  config: AgentConfigSnapshot
  snapshot: MaterializedSnapshot
  client: RuntimeClient
  subscription: NotificationSubscriptionLike | undefined
  sessionConversations: Map<string, string>
  turns: Map<string, TurnEventAdapter>
  /** 该运行时承载过的对话（排障视图用）。 */
  conversations: Set<string>
  running: Set<string>
  /** 本实例里已 resume（或已确认可直接 prompt）的 session。 */
  resumed: Set<string>
  startedAt: number
  lastActiveAt: number
  closing: boolean
}

export interface RuntimePoolDeps {
  config: {
    dshBin: string
    dshProfile: string
    runtimeIdleMs: number
    turnTimeoutMs: number
    maxRuntimes: number
  }
  logger: Logger
  materializer: SnapshotMaterializer
  hub: SseHub
  sink: RuntimeConversationSink
  clientFactory: RuntimeClientFactory
  now?: () => number
}

/* ------------------------------------------------------------------ 池 */

export class RuntimePool {
  private readonly entries = new Map<string, RuntimeEntry>()
  /**
   * 正在初始化中的运行时（configKey → promise）。
   *
   * 没有这张表时存在竞态：A 发现没有运行时 → 开始 await initialize；
   * B 此时仍发现没有 → 也启动一个进程，两个实例抢同一个 home/配置目录。
   */
  private readonly pending = new Map<string, Promise<RuntimeEntry>>()
  private reaper: NodeJS.Timeout | undefined
  private serial = 0
  private readonly now: () => number

  constructor(private readonly deps: RuntimePoolDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  /** 运行时排障视图（GET /api/runtimes），字段与 `RuntimeInfo` 完全一致。 */
  status(): RuntimeInfo[] {
    return [...this.entries.values()].map((entry) => ({
      runtimeId: entry.runtimeId,
      configKey: entry.configKey,
      provider: entry.config.provider,
      model: entry.config.model,
      skills: [...entry.config.skills],
      mcpServers: [...entry.config.mcpServers],
      conversationCount: entry.conversations.size,
      runningCount: entry.running.size,
      startedAt: entry.startedAt,
      lastActiveAt: entry.lastActiveAt,
    }))
  }

  /** 是否还有名额（没有则路由应在进入 SSE 之前返回 503）。 */
  canAcquire(configKey: string): boolean {
    if (this.entries.has(configKey)) return true
    if (this.entries.size < this.deps.config.maxRuntimes) return true
    return [...this.entries.values()].some((entry) => entry.running.size === 0)
  }

  /**
   * 发送一轮：确保运行时与会话，`prompt()` 后等 idle / 失败。
   *
   * 返回的 promise **不会**因为运行时故障 reject（进入流之后一律用 message.failed），
   * 只有配置/容量类错误会抛 `ApiError`（此时调用方可退回 4xx/5xx）。
   */
  async send(input: SendTurnInput): Promise<SendTurnResult> {
    const entry = await this.acquire(input.config)
    if (entry.running.has(input.conversationId)) throw conversationRunning()

    // 恢复历史会话**先于**任何运行状态登记：失败时不会留下"半轮"，
    // 也不会在用户以为上下文还在的情况下悄悄开一个空白会话（review P0-4）。
    await this.ensureSession(entry, input)

    let resolved = false
    let timer: NodeJS.Timeout | undefined
    let resolveDone: (result: SendTurnResult) => void = () => undefined
    const done = new Promise<SendTurnResult>((resolve) => {
      resolveDone = resolve
    })
    const settle = (result: SendTurnResult): void => {
      if (resolved) return
      resolved = true
      if (timer !== undefined) clearTimeout(timer)
      resolveDone(result)
    }

    const adapter = new TurnEventAdapter({
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      publish: (event) => this.deps.hub.publish(event),
      persistAssistantMessage: ({ text, toolCalls }) =>
        this.deps.sink.appendAssistant(input.conversationId, { text, toolCalls }),
      updateToolCalls: (messageId, toolCalls) =>
        this.deps.sink.updateToolCalls(input.conversationId, messageId, toolCalls),
      onTerminal: (outcome) => {
        if (outcome === 'idle') {
          this.deps.sink.markIdle(input.conversationId)
          settle({ outcome, runtimeId: entry.runtimeId })
        } else {
          const failure = adapter.lastFailure
          this.deps.sink.markFailed(input.conversationId, failure?.message ?? '本轮失败')
          settle({
            outcome,
            runtimeId: entry.runtimeId,
            ...(failure === undefined ? {} : { error: failure.message }),
          })
        }
      },
      logger: this.deps.logger.child({ conversationId: input.conversationId }),
    })

    entry.turns.set(input.sessionId, adapter)
    entry.sessionConversations.set(input.sessionId, input.conversationId)
    entry.conversations.add(input.conversationId)
    entry.running.add(input.conversationId)
    entry.lastActiveAt = this.now()

    timer = setTimeout(() => {
      adapter.fail('TIMEOUT', `本轮超过 ${this.deps.config.turnTimeoutMs}ms 未结束`)
      // 超时按失败处理，并关闭该运行时（SDK 没有 turn 级取消）。
      void this.closeEntry(entry, 'turn timeout').catch((error) =>
        this.deps.logger.warn('closing timed-out runtime failed', error),
      )
    }, this.deps.config.turnTimeoutMs)

    try {
      await entry.client.prompt(input.sessionId, [{ type: 'text', text: input.text }])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      adapter.fail('RUNTIME_CLOSED', message)
      await this.closeEntry(entry, 'prompt failed').catch(() => undefined)
    }

    const result = await done
    entry.turns.delete(input.sessionId)
    entry.sessionConversations.delete(input.sessionId)
    entry.running.delete(input.conversationId)
    entry.lastActiveAt = this.now()
    return result
  }

  /**
   * 确保该会话在运行时里可用。
   *
   * - 首次消息（`hasHistory=false`）：直接 `prompt` 让 DSH 创建会话；
   * - 已有历史：必须先 `resumeSession` 成功；失败一律 409 `SESSION_RESTORE_FAILED`，
   *   **绝不**静默创建空白会话（否则用户会以为模型还记得上文）。
   */
  private async ensureSession(entry: RuntimeEntry, input: SendTurnInput): Promise<void> {
    if (entry.resumed.has(input.sessionId)) return
    if (!input.hasHistory) {
      entry.resumed.add(input.sessionId)
      return
    }
    try {
      await entry.client.resumeSession(input.sessionId)
      entry.resumed.add(input.sessionId)
      this.deps.logger.info('resumed existing session', {
        runtimeId: entry.runtimeId,
        sessionId: input.sessionId,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.deps.logger.error('session restore failed', {
        runtimeId: entry.runtimeId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        error: message,
      })
      throw new ApiError(
        'SESSION_RESTORE_FAILED',
        `历史会话恢复失败：${message}`,
        { conversationId: input.conversationId, sessionId: input.sessionId },
        409,
      )
    }
  }

  /**
   * 停止某个对话正在执行的一轮。
   *
   * SDK 没有单轮取消接口，停止 = 关闭承载它的运行时。为了不误伤同一运行时上的其它
   * 对话，只有当它是该运行时上唯一运行中的对话时才允许；否则 409 `RUNTIME_BUSY`。
   */
  async stop(conversationId: string): Promise<{ runtimeClosed: boolean; note?: string }> {
    const entry = [...this.entries.values()].find((candidate) => candidate.running.has(conversationId))
    if (entry === undefined) {
      return { runtimeClosed: false, note: '该对话当前没有正在执行的轮次' }
    }
    const others = [...entry.running].filter((id) => id !== conversationId)
    if (others.length > 0) {
      throw new ApiError(
        'RUNTIME_BUSY',
        `该运行时上还有 ${others.length} 个对话正在运行，停止会中断它们；请等待或先停止其它对话`,
        { runtimeId: entry.runtimeId, running: others.length },
        409,
      )
    }
    await this.closeEntry(entry, 'client stop')
    return { runtimeClosed: true, note: '已关闭承载该对话的运行时（SDK 无单轮取消接口）' }
  }
  /** 手动触发一次空闲回收（测试与排障用；生产由 30s 定时器调用）。 */
  async reapNow(): Promise<void> {
    const now = this.now()
    for (const entry of [...this.entries.values()]) {
      if (entry.running.size > 0) continue
      if (now - entry.lastActiveAt < this.deps.config.runtimeIdleMs) continue
      await this.closeEntry(entry, 'idle').catch((error) =>
        this.deps.logger.warn('idle reap failed', { runtimeId: entry.runtimeId, error }),
      )
    }
  }

  startReaper(intervalMs = 30_000): void {
    if (this.reaper !== undefined) return
    this.reaper = setInterval(() => {
      void this.reapNow().catch((error) => this.deps.logger.warn('reaper failed', error))
    }, intervalMs)
  }

  async closeAll(): Promise<void> {
    if (this.reaper !== undefined) {
      clearInterval(this.reaper)
      this.reaper = undefined
    }
    await Promise.all([...this.entries.values()].map((entry) => this.closeEntry(entry, 'shutdown')))
  }

  /* ---------------------------------------------------------------- 内部 */

  private async acquire(config: AgentConfigSnapshot): Promise<RuntimeEntry> {
    const existing = this.entries.get(config.configKey)
    if (existing !== undefined && !existing.closing) return existing

    // 同配置的冷启动合并到同一个 promise（review P0-2）。
    const inflight = this.pending.get(config.configKey)
    if (inflight !== undefined) return await inflight

    const task = this.createEntry(config)
    this.pending.set(config.configKey, task)
    try {
      return await task
    } finally {
      this.pending.delete(config.configKey)
    }
  }

  /** 真正创建运行时（只由 acquire 调用；并发由 pending 去重）。 */
  private async createEntry(config: AgentConfigSnapshot): Promise<RuntimeEntry> {
    if (this.entries.size >= this.deps.config.maxRuntimes) {
      const victim = [...this.entries.values()]
        .filter((entry) => entry.running.size === 0)
        .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]
      if (victim === undefined) {
        throw new ApiError(
          'RUNTIME_ERROR',
          `运行时数量已达上限 ${this.deps.config.maxRuntimes}，且没有可回收的空闲运行时`,
          { maxRuntimes: this.deps.config.maxRuntimes },
          503,
        )
      }
      await this.closeEntry(victim, 'capacity')
    }

    const materialized = this.deps.materializer.materialize(config)
    this.serial += 1
    const runtimeId = `${config.configKey}-${this.serial}`
    const client = this.deps.clientFactory({
      dshBin: this.deps.config.dshBin,
      profile: this.deps.config.dshProfile,
      dshHome: materialized.homeDir,
      processCwd: materialized.workspaceDir,
      patches: [materialized.agentPatchPath, materialized.mcpPatchPath, materialized.providerPatchPath],
      env: materialized.env,
    })

    try {
      client.start()
      await client.initialize({
        cwd: materialized.workspaceDir,
        provider: config.provider,
        model: config.model,
      })
    } catch (error) {
      await client.close().catch(() => undefined)
      throw new ApiError(
        'RUNTIME_ERROR',
        `运行时启动失败: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const entry: RuntimeEntry = {
      runtimeId,
      configKey: config.configKey,
      config,
      snapshot: materialized,
      client,
      subscription: undefined,
      sessionConversations: new Map(),
      turns: new Map(),
      conversations: new Set(),
      running: new Set(),
      resumed: new Set(),
      startedAt: this.now(),
      lastActiveAt: this.now(),
      closing: false,
    }
    this.entries.set(config.configKey, entry)
    this.startPump(entry)
    this.deps.logger.info('runtime started', {
      runtimeId,
      configKey: config.configKey,
      provider: config.provider,
      model: config.model,
      skills: config.skills,
      mcpServers: config.mcpServers,
    })
    return entry
  }

  private startPump(entry: RuntimeEntry): void {
    entry.subscription = entry.client.subscribe(() => true)
    const subscription = entry.subscription
    const pump = (async () => {
      for (;;) {
        let notification: HarnessNotification
        try {
          notification = await subscription.next()
        } catch (error) {
          if (!entry.closing) this.handleRuntimeFailure(entry, error)
          return
        }
        this.dispatch(entry, notification)
      }
    })()
    // 泵自身的异常只记录（否则会成为 unhandled rejection）。
    void pump.catch((error) => {
      this.deps.logger.warn('runtime notification pump failed', { runtimeId: entry.runtimeId, error })
    })
  }

  private dispatch(entry: RuntimeEntry, notification: HarnessNotification): void {
    const sessionId = notification.params.sessionId
    if (typeof sessionId !== 'string') return
    entry.lastActiveAt = this.now()
    const adapter = entry.turns.get(sessionId)
    if (adapter === undefined) return
    adapter.handleNotification(notification)
  }

  /** 传输层关闭 / 子进程退出：该运行时上所有运行中对话收到 message.failed。 */
  private handleRuntimeFailure(entry: RuntimeEntry, error: unknown): void {
    if (entry.closing) return
    const message = error instanceof Error ? error.message : String(error)
    this.deps.logger.error('runtime transport closed', {
      runtimeId: entry.runtimeId,
      error: error instanceof Error ? { name: error.name, message: error.message } : error,
    })
    this.entries.delete(entry.configKey)
    entry.closing = true
    for (const adapter of [...entry.turns.values()]) adapter.fail('RUNTIME_CLOSED', message)
    void entry.client.close().catch(() => undefined)
  }

  private async closeEntry(entry: RuntimeEntry, reason: string): Promise<void> {
    if (entry.closing) return
    entry.closing = true
    if (this.entries.get(entry.configKey) === entry) this.entries.delete(entry.configKey)
    try {
      entry.subscription?.close()
    } catch (error) {
      this.deps.logger.warn('closing subscription failed', { runtimeId: entry.runtimeId, error })
    }
    for (const adapter of [...entry.turns.values()]) {
      adapter.fail('RUNTIME_CLOSED', `运行时已回收（${reason}）`)
    }
    try {
      await entry.client.close()
    } catch (error) {
      this.deps.logger.warn('runtime close failed', { runtimeId: entry.runtimeId, error })
    }
    this.deps.logger.info('runtime closed', { runtimeId: entry.runtimeId, reason })
  }
}
