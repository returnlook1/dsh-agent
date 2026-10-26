/**
 * 按 `conversationId` 分发的进程内 SSE 事件总线。
 *
 * - `publish` 同步扇出；单个订阅者抛异常不影响其它订阅者或运行时；
 * - 断开只解绑，不杀运行时（本轮继续跑完并落库）；
 * - `shutdown` 主动关闭所有流（优雅退出时使用）。
 */
import type { ServiceEvent } from '@agent-studio/shared'
import type { Logger } from '../logger.js'

export type ServiceEventListener = (event: ServiceEvent) => void

interface Channel {
  listeners: Set<ServiceEventListener>
  closers: Set<() => void>
}

export class SseHub {
  private readonly channels = new Map<string, Channel>()
  private closed = false

  constructor(private readonly logger: Logger) {}

  private channel(conversationId: string): Channel {
    const existing = this.channels.get(conversationId)
    if (existing !== undefined) return existing
    const created: Channel = { listeners: new Set(), closers: new Set() }
    this.channels.set(conversationId, created)
    return created
  }

  publish(event: ServiceEvent): void {
    if (this.closed) return
    const channel = this.channels.get(event.conversationId)
    if (channel === undefined) return
    for (const listener of [...channel.listeners]) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn('sse listener threw', { conversationId: event.conversationId, error })
      }
    }
  }

  /**
   * 订阅某对话的事件。
   * @param onShutdown 服务关闭时调用（路由用它结束响应，避免挂住的连接拖死退出）
   * @returns 解绑函数
   */
  subscribe(conversationId: string, listener: ServiceEventListener, onShutdown?: () => void): () => void {
    const channel = this.channel(conversationId)
    channel.listeners.add(listener)
    if (onShutdown !== undefined) channel.closers.add(onShutdown)
    return () => {
      channel.listeners.delete(listener)
      if (onShutdown !== undefined) channel.closers.delete(onShutdown)
      if (channel.listeners.size === 0 && channel.closers.size === 0) this.channels.delete(conversationId)
    }
  }

  listenerCount(conversationId: string): number {
    return this.channels.get(conversationId)?.listeners.size ?? 0
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const channel of [...this.channels.values()]) {
      for (const closer of [...channel.closers]) {
        try {
          closer()
        } catch (error) {
          this.logger.warn('sse shutdown handler threw', error)
        }
      }
      channel.listeners.clear()
      channel.closers.clear()
    }
    this.channels.clear()
  }
}
