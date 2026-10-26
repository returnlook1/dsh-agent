/**
 * 一次用户请求的执行编排。
 *
 * - 校验归属/状态/限流/并发；
 * - 先落库 user 消息（sequence+1）并生成标题；
 * - 订阅 SseHub → 确保运行时 → prompt；
 * - 保证事件流有且只有一个终止事件。
 *
 * 路由层通过 `handle.open()` 把事件写入 SSE 响应；在 `open` 之前到达的事件
 * 会先进入缓冲区，避免"响应头还没写、事件已经到了"的丢失。
 */
import type { AgentEvent, MessageDto, ToolRisk, UserDto } from '@agent-studio/shared'
import type { SessionRow } from '../db/types.js'
import type { Logger } from '../logger.js'
import type { AgentVersionsRepository } from '../repositories/agentVersions.js'
import type { MessagesRepository } from '../repositories/messages.js'
import type { SessionsRepository } from '../repositories/sessions.js'
import type { ToolCatalog } from '../runtime/ToolCatalog.js'
import type { SseHub } from '../runtime/SseHub.js'
import { conflict, notFound, rateLimited } from '../http/errors.js'

const TERMINAL_TYPES = new Set<AgentEvent['type']>(['agent.completed', 'agent.failed', 'run.limit'])

export interface RunRuntimePort {
  ensure(input: {
    session: SessionRow
    toolLookup: {
      supportsApprovalChannel(name: string): boolean
      riskFor(name: string): ToolRisk | undefined
    }
  }): Promise<{ runtimeId: string; dshSessionId: string }>
  prompt(sessionId: string, text: string): Promise<void>
  stopSession(sessionId: string, reason?: string): Promise<void>
}

export interface RunServiceDeps {
  sessions: SessionsRepository
  messages: MessagesRepository
  versions: AgentVersionsRepository
  runtime: RunRuntimePort
  hub: SseHub
  toolCatalog: ToolCatalog
  logger: Logger
  now?: () => number
}

export interface StartRunInput {
  session: SessionRow
  user: UserDto
  content: string
}

export interface RunHandle {
  /** 绑定 SSE 写函数并冲刷缓冲事件。 */
  open(sink: (event: AgentEvent) => void): void
  /** 客户端断开：停止转发（**不**关闭运行时）。 */
  detach(): void
  /** 终止事件到达时 resolve。 */
  done: Promise<AgentEvent | undefined>
  /** 已收到的终止事件（若已完成）。 */
  terminal(): AgentEvent | undefined
}

class RunChannel {
  private sink: ((event: AgentEvent) => void) | undefined
  private buffer: AgentEvent[] = []
  private terminalEvent: AgentEvent | undefined
  private ended = false
  private resolveDone: (event: AgentEvent | undefined) => void = () => undefined
  readonly done: Promise<AgentEvent | undefined>

  constructor(
    readonly sessionId: string,
    private readonly onTerminalEvent: (event: AgentEvent) => void,
  ) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve
    })
  }

  open(sink: (event: AgentEvent) => void): void {
    this.sink = sink
    const pending = this.buffer
    this.buffer = []
    for (const event of pending) sink(event)
  }

  isEnded(): boolean {
    return this.ended
  }

  terminal(): AgentEvent | undefined {
    return this.terminalEvent
  }

  accept(event: AgentEvent): void {
    if (this.ended) return
    if (TERMINAL_TYPES.has(event.type)) {
      this.ended = true
      this.terminalEvent = event
      this.emit(event)
      this.onTerminalEvent(event)
      this.resolveDone(event)
      this.sink = undefined
      this.buffer = []
      return
    }
    this.emit(event)
  }

  detach(): void {
    this.sink = undefined
    this.buffer = []
  }

  private emit(event: AgentEvent): void {
    if (this.sink !== undefined) {
      this.sink(event)
      return
    }
    this.buffer.push(event)
  }
}

export class RunService {
  private readonly now: () => number

  constructor(private readonly deps: RunServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
  }

  start(input: StartRunInput): RunHandle {
    const { session, user, content } = input
    if (user.role !== 'admin' && session.user_id !== user.id) {
      throw notFound(`会话不存在: ${session.id}`)
    }
    if (session.status !== 'idle') {
      throw conflict('会话正在运行，请等待当前回复结束或先停止生成', { status: session.status })
    }

    const version = this.deps.versions.get(session.agent_id, Number(session.agent_version))
    if (version === undefined) throw conflict('会话对应的 Agent 版本不存在，无法继续')

    const now = this.now()
    const limits = version.config.limits
    const recent = this.deps.messages.countUserMessagesSince(user.id, session.agent_id, now - 3_600_000)
    if (recent >= limits.maxRequestsPerHour) {
      throw rateLimited(`已达到每小时请求上限（${limits.maxRequestsPerHour}），请稍后再试`, {
        limit: limits.maxRequestsPerHour,
      })
    }
    const running = this.deps.sessions.countRunning(user.id, session.agent_id)
    if (running >= limits.maxConcurrentRuns) {
      throw conflict(`并发运行数超过上限（${limits.maxConcurrentRuns}）`, {
        limit: limits.maxConcurrentRuns,
      })
    }

    // 先落库用户消息，再进入流式响应（失败也不会丢用户输入）。
    const userMessage: MessageDto = this.deps.messages.toDto(
      this.deps.messages.append({ sessionId: session.id, role: 'user', content }),
    )
    if (session.title.trim() === '') {
      const title = content.replace(/\s+/g, ' ').trim().slice(0, 40)
      if (title !== '') this.deps.sessions.updateTitle(session.id, title)
    }
    this.deps.sessions.updateStatus(session.id, 'running')

    let unsubscribe: () => void = () => undefined
    const channel = new RunChannel(session.id, (event) => {
      if (event.type === 'agent.failed') {
        this.deps.sessions.updateStatus(session.id, 'failed')
      } else if (event.type === 'agent.completed' || event.type === 'run.limit') {
        this.deps.sessions.updateStatus(session.id, 'idle')
      }
      // 终止事件到达后解除内存订阅，避免长连接/长进程泄漏监听器。
      unsubscribe()
    })

    // 必须先订阅再 prompt，否则可能丢 run.started / 首个 delta。
    unsubscribe = this.deps.hub.subscribe(session.id, (event) => channel.accept(event))

    const enrichedSession: SessionRow = { ...session, status: 'running' }
    const task = (async () => {
      try {
        await this.deps.runtime.ensure({
          session: enrichedSession,
          toolLookup: {
            supportsApprovalChannel: (name) => this.deps.toolCatalog.supportsApprovalChannel(name),
            riskFor: (name) => this.deps.toolCatalog.riskFor(name),
          },
        })
        if (channel.isEnded()) return
        await this.deps.runtime.prompt(session.id, content)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.logger.error('run failed', { sessionId: session.id, message, userMessage: userMessage.id })
        if (!channel.isEnded()) {
          // 通过 hub 发布，确保 GET /stream 的订阅者也能收到终止事件。
          this.deps.hub.publish({
            type: 'agent.failed',
            sessionId: session.id,
            message,
            code: 'runtime-error',
            at: this.now(),
          })
        }
      }
    })()

    // 后台任务的异常必须接住，不能产生 unhandled rejection。
    void task.catch((error) => this.deps.logger.error('run task rejected', { sessionId: session.id, error }))

    return {
      open: (sink) => channel.open(sink),
      detach: () => {
        unsubscribe()
        channel.detach()
      },
      done: channel.done,
      terminal: () => channel.terminal(),
    }
  }
}
