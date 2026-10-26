/** 会话路由 + SSE（发送消息、断线重连订阅、停止、审批/消息读取）。 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { toSseFrame, type AgentEvent, type SessionDto } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthGuards } from '../auth/guard.js'
import { parseInput } from '../http/errors.js'

const sessionParams = z.object({ id: z.string().min(1).max(128) })
const listQuery = z.object({ agentId: z.string().min(1).max(64).optional() })
const sendMessageSchema = z.object({ content: z.string().min(1).max(100_000) })

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const

const HEARTBEAT_MS = 15_000

/**
 * 建立 SSE 响应：hijack Fastify 的 reply，直接写 Node 原生响应流。
 * 返回写入函数与清理函数。
 */
function openSse(reply: FastifyReply): {
  write: (chunk: string) => void
  isClosed: () => boolean
  end: () => void
} {
  reply.hijack()
  const res = reply.raw
  res.writeHead(200, SSE_HEADERS)
  res.flushHeaders()
  let closed = false
  res.on('close', () => {
    closed = true
  })
  return {
    write: (chunk: string) => {
      if (closed || res.writableEnded) return
      res.write(chunk)
    },
    isClosed: () => closed || res.writableEnded,
    end: () => {
      if (!res.writableEnded) {
        try {
          res.end()
        } catch {
          // 连接可能已被对端关闭。
        }
      }
    },
  }
}

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  app.get('/api/sessions', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const query = parseInput(listQuery, request.query ?? {}, '查询参数')
    reply.send(ctx.services.sessions.list(user, query.agentId))
  })

  app.get('/api/sessions/:id', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(sessionParams, request.params, '路径参数')
    const session: SessionDto = ctx.services.sessions.get(id, user)
    reply.send(session)
  })

  app.get('/api/sessions/:id/messages', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(sessionParams, request.params, '路径参数')
    reply.send(ctx.services.sessions.messages(id, user))
  })

  app.get('/api/sessions/:id/approvals', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(sessionParams, request.params, '路径参数')
    reply.send(ctx.services.sessions.approvals(id, user))
  })

  app.post('/api/sessions/:id/stop', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(sessionParams, request.params, '路径参数')
    reply.send(await ctx.services.sessions.stop(id, user))
  })

  /**
   * 发送消息：SSE 响应。
   * 校验（归属/状态/限流/并发）在进入流之前完成，失败返回普通 JSON 错误。
   */
  app.post('/api/sessions/:id/messages', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(sessionParams, request.params, '路径参数')
    const session = ctx.services.sessions.requireOwned(id, user)
    const body = parseInput(sendMessageSchema, request.body, '发送消息请求')

    const handle = ctx.services.runs.start({ session, user, content: body.content })
    const sse = openSse(reply)

    const heartbeat = setInterval(() => {
      sse.write(': ping\n\n')
    }, HEARTBEAT_MS)
    heartbeat.unref()

    const offShutdown = ctx.hub.onShutdown(() => {
      sse.end()
    })

    // 写函数：每条事件一帧。
    handle.open((event: AgentEvent) => {
      sse.write(toSseFrame(event))
    })

    const finish = (): void => {
      clearInterval(heartbeat)
      offShutdown()
      sse.end()
    }

    // 客户端断开：只解除订阅，**绝不**关闭运行时。
    reply.raw.on('close', () => {
      if (!sse.isClosed()) return
      clearInterval(heartbeat)
      offShutdown()
      handle.detach()
    })

    void handle.done
      .then(() => finish())
      .catch((error) => {
        ctx.logger.error('sse send stream failed', { sessionId: id, error })
        finish()
      })
  })

  /** 断线重连：只推后续事件（+ 最近一次 run.started），历史走 messages 接口。 */
  app.get('/api/sessions/:id/stream', { preHandler: [guards.authenticate] }, async (request, reply) => {
    const { user } = requireAuth(request)
    const { id } = parseInput(sessionParams, request.params, '路径参数')
    ctx.services.sessions.requireOwned(id, user)

    const sse = openSse(reply)
    const unsubscribe = ctx.hub.subscribe(
      id,
      (event) => {
        sse.write(toSseFrame(event))
      },
      { replayRunStarted: true },
    )
    const heartbeat = setInterval(() => {
      sse.write(': ping\n\n')
    }, HEARTBEAT_MS)
    heartbeat.unref()

    const cleanup = (): void => {
      clearInterval(heartbeat)
      unsubscribe()
    }
    const offShutdown = ctx.hub.onShutdown(() => {
      cleanup()
      sse.end()
    })
    reply.raw.on('close', () => {
      cleanup()
      offShutdown()
    })
  })
}
