/**
 * 对话接口（docs/SERVICE.md §7 / §8）。
 *
 * SSE 规则（§8）：
 * - 进入流之前：4xx/5xx JSON（NOT_FOUND / CONVERSATION_RUNNING / VALIDATION_ERROR / 503）；
 * - 进入流之后：所有错误变成 `message.failed`；
 * - 恰好一个终止动作：idle（正常收尾，直接 end）、failed（message.failed 帧）、timeout（由池转换
 *   成 message.failed{TIMEOUT} 后 end）；
 * - 客户端断开只解绑 SSE，**不**终止运行时（本轮继续跑完并落库）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  createConversationRequestSchema,
  sendMessageRequestSchema,
  updateConversationConfigRequestSchema,
  type ConversationDto,
  type CreateConversationResponse,
  type MessageListResponse,
  type ServiceEvent,
} from '@agent-studio/shared'
import { toSseFrame } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import { ApiError, parseInput } from '../http/errors.js'

interface ConversationParams {
  id: string
}

const PING_INTERVAL_MS = 15_000

function conversationIdOf(request: FastifyRequest): string {
  return (request.params as ConversationParams).id
}

function parseLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : undefined
  if (value === undefined || !Number.isFinite(value)) return 50
  return Math.min(200, Math.max(1, Math.floor(value)))
}

export function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/conversations', async (request, reply) => {
    const body = parseInput(createConversationRequestSchema, request.body, '创建对话请求')
    const record = ctx.conversations.create(body)
    const response: CreateConversationResponse = {
      conversationId: record.id,
      sessionId: record.sessionId,
      config: record.config,
    }
    reply.status(201).send(response)
  })

  app.get('/api/conversations', async (request) => {
    const query = request.query as Record<string, unknown>
    const projectId = typeof query.projectId === 'string' && query.projectId !== '' ? query.projectId : undefined
    return {
      conversations: ctx.conversations.list({
        ...(projectId === undefined ? {} : { projectId }),
        limit: parseLimit(query.limit),
      }),
    }
  })

  app.get('/api/conversations/:id', async (request): Promise<ConversationDto> => {
    return ctx.conversations.getOrThrow(conversationIdOf(request))
  })

  app.get('/api/conversations/:id/config', async (request) => {
    return ctx.conversations.getOrThrow(conversationIdOf(request)).config
  })

  app.put('/api/conversations/:id/config', async (request) => {
    const conversationId = conversationIdOf(request)
    const body = parseInput(updateConversationConfigRequestSchema, request.body ?? {}, '对话配置')
    return ctx.conversations.updateConfig(conversationId, body)
  })

  app.get('/api/conversations/:id/messages', async (request): Promise<MessageListResponse> => {
    const conversationId = conversationIdOf(request)
    const result = ctx.conversations.messages(conversationId)
    return {
      conversationId,
      messages: result.messages,
      ...(result.truncated ? { truncated: true } : {}),
    }
  })

  app.post('/api/conversations/:id/messages', async (request, reply) => {
    const conversationId = conversationIdOf(request)
    const body = parseInput(sendMessageRequestSchema, request.body, '消息')

    const existing = ctx.conversations.getOrThrow(conversationId)
    // 容量预检放在进入流之前，这样"没有可用运行时"能返回 503 JSON（§5）。
    if (!ctx.pool.canAcquire(existing.config.configKey)) {
      throw new ApiError('RUNTIME_ERROR', '运行时数量已达上限且没有可回收的空闲运行时', undefined, 503)
    }

    // 落库 user 消息 + 置 running（同步，检查与写入之间没有 await 窗口）。
    const { conversation, message } = ctx.conversations.beginTurn(conversationId, body.content)

    startSse(ctx, request, reply, {
      conversationId,
      conversation,
      userMessageId: message.id,
      text: body.content,
      hasHistory: conversation.messageCount > 1,
    })
  })
}

interface SseInput {
  conversationId: string
  conversation: ConversationDto
  userMessageId: string
  text: string
  hasHistory: boolean
}

/**
 * 接管原生响应。返回的 promise 在流结束后 resolve（Fastify 不等待，
 * 但错误路径仍会记录日志，避免 unhandled rejection）。
 */
function startSse(ctx: AppContext, request: FastifyRequest, reply: FastifyReply, input: SseInput): void {
  void runSse(ctx, request, reply, input).catch((error) => {
    ctx.logger.error('sse handler failed', {
      conversationId: input.conversationId,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    })
  })
}

async function runSse(
  ctx: AppContext,
  _request: FastifyRequest,
  reply: FastifyReply,
  input: SseInput,
): Promise<void> {
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  raw.flushHeaders()

  let finished = false
  let sawFailure = false
  const ping = setInterval(() => {
    if (!finished) raw.write(': ping\n\n')
  }, PING_INTERVAL_MS)
  // 心跳不能拖住进程退出。
  ping.unref()

  let unbind: () => void = () => undefined
  const finish = (): void => {
    if (finished) return
    finished = true
    clearInterval(ping)
    unbind()
    try {
      raw.end()
    } catch {
      // 客户端已断开。
    }
  }

  const writeEvent = (event: ServiceEvent): void => {
    if (finished) return
    raw.write(toSseFrame(event))
    if (event.type === 'message.failed') {
      sawFailure = true
      finish()
    }
  }

  unbind = ctx.hub.subscribe(input.conversationId, writeEvent, finish)
  raw.on('error', (error) => {
    // 客户端异常断开时不能让它变成未捕获的 'error' 事件。
    ctx.logger.warn('sse response error', {
      conversationId: input.conversationId,
      error: error instanceof Error ? error.message : String(error),
    })
  })
  raw.on('close', () => {
    // 客户端断开：只解绑，不杀运行时（本轮继续跑完并落库）。
    if (finished) return
    finished = true
    clearInterval(ping)
    unbind()
  })

  // 用户消息已落库 → message.started
  ctx.hub.publish({
    type: 'message.started',
    conversationId: input.conversationId,
    messageId: input.userMessageId,
    role: 'user',
    at: Date.now(),
  })

  try {
    await ctx.pool.send({
      conversationId: input.conversationId,
      sessionId: input.conversation.sessionId,
      config: input.conversation.config,
      text: input.text,
      hasHistory: input.hasHistory,
    })
  } catch (error) {
    // 已进入流：一律转成 message.failed（若 adapter 已经发过失败事件则不重复）。
    if (!sawFailure) {
      const code = error instanceof ApiError ? error.code : 'RUNTIME_ERROR'
      const message = error instanceof Error ? error.message : String(error)
      ctx.conversations.markFailed(input.conversationId, message)
      ctx.hub.publish({
        type: 'message.failed',
        conversationId: input.conversationId,
        message,
        code,
        at: Date.now(),
      })
    }
  } finally {
    finish()
  }
}
