/**
 * 按会话分发的进程内事件总线。
 *
 * - `publish` 是同步的：事件先落内存订阅者，再由调用方保证数据库副作用已完成；
 * - 迟到订阅（断线重连）只回放**最近一次** `run.started`，其余历史走 messages 接口；
 * - `shutdown` 关闭所有 SSE 响应（优雅退出时使用）。
 */
import type { AgentEvent, RunStartedEvent } from '@agent-studio/shared'
import type { Logger } from '../logger.js'

export type AgentEventListener = (event: AgentEvent) => void

export interface SubscribeOptions {
  /** 迟到订阅时先回放最近的 run.started（断线重连语义）。 */
  replayRunStarted?: boolean
}

interface SessionChannel {
  listeners: Set<AgentEventListener>
  lastRunStarted?: RunStartedEvent
}

export class SseHub {
  private readonly channels = new Map<string, SessionChannel>()
  private readonly shutdownHandlers = new Set<() => void>()
  private closed = false

  constructor(private readonly logger: Logger) {}

  private channel(sessionId: string): SessionChannel {
    const existing = this.channels.get(sessionId)
    if (existing !== undefined) return existing
    const created: SessionChannel = { listeners: new Set() }
    this.channels.set(sessionId, created)
    return created
  }

  publish(event: AgentEvent): void {
    if (this.closed) return
    const channel = this.channel(event.sessionId)
    if (event.type === 'run.started') channel.lastRunStarted = event
    for (const listener of [...channel.listeners]) {
      try {
        listener(event)
      } catch (error) {
        // 单个订阅者异常不能影响其它订阅者或运行时。
        this.logger.warn('sse listener threw', { sessionId: event.sessionId, error })
      }
    }
  }

  subscribe(sessionId: string, listener: AgentEventListener, options: SubscribeOptions = {}): () => void {
    const channel = this.channel(sessionId)
    channel.listeners.add(listener)
    if (options.replayRunStarted === true && channel.lastRunStarted !== undefined) {
      try {
        listener(channel.lastRunStarted)
      } catch (error) {
        this.logger.warn('sse replay listener threw', { sessionId, error })
      }
    }
    return () => {
      channel.listeners.delete(listener)
      if (channel.listeners.size === 0 && channel.lastRunStarted === undefined) {
        this.channels.delete(sessionId)
      }
    }
  }

  listenerCount(sessionId: string): number {
    return this.channels.get(sessionId)?.listeners.size ?? 0
  }

  /** 注册"关闭该 SSE 连接"的回调（不关闭运行时）。 */
  onShutdown(handler: () => void): () => void {
    this.shutdownHandlers.add(handler)
    return () => this.shutdownHandlers.delete(handler)
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const handler of [...this.shutdownHandlers]) {
      try {
        handler()
      } catch (error) {
        this.logger.warn('sse shutdown handler threw', error)
      }
    }
    this.shutdownHandlers.clear()
    for (const channel of this.channels.values()) channel.listeners.clear()
    this.channels.clear()
  }
}
