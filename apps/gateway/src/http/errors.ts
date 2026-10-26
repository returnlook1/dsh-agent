/**
 * 统一错误响应：`{ error: { code, message, details? } }`（docs/SERVICE.md §7）。
 *
 * 路由只抛 `ApiError`；其它异常由 Fastify 错误处理器记录并降级为 `INTERNAL_ERROR`。
 * `CONVERSATION_STARTED` / `CONVERSATION_RUNNING` 是 §7/§8 明确要求的两个 409 业务码。
 */
import fs from 'node:fs'
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { Logger } from '../logger.js'

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SKILL_UNKNOWN'
  | 'MCP_UNKNOWN'
  | 'MODEL_UNKNOWN'
  | 'MODEL_UNAVAILABLE'
  | 'RUNTIME_ERROR'
  | 'SERVICE_TOKEN_INVALID'
  | 'INTERNAL_ERROR'
  | 'CONVERSATION_STARTED'
  | 'CONVERSATION_RUNNING'

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  SKILL_UNKNOWN: 400,
  MCP_UNKNOWN: 400,
  MODEL_UNKNOWN: 400,
  MODEL_UNAVAILABLE: 503,
  RUNTIME_ERROR: 502,
  SERVICE_TOKEN_INVALID: 401,
  INTERNAL_ERROR: 500,
  CONVERSATION_STARTED: 409,
  CONVERSATION_RUNNING: 409,
}

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly statusCode: number
  readonly details: unknown

  constructor(code: ApiErrorCode, message: string, details?: unknown, statusCode?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.statusCode = statusCode ?? ERROR_STATUS[code]
    this.details = details
  }
}

export const notFound = (message = '资源不存在'): ApiError => new ApiError('NOT_FOUND', message)

export const validationError = (message: string, details?: unknown): ApiError =>
  new ApiError('VALIDATION_ERROR', message, details)

export const conflict = (message: string, details?: unknown): ApiError => new ApiError('CONFLICT', message, details)

/** 对话已有消息后不允许再改配置（§7）。 */
export const conversationStarted = (): ApiError =>
  new ApiError('CONVERSATION_STARTED', '对话已开始，配置快照不可再修改')

/** 对话正在运行（§8）。 */
export const conversationRunning = (): ApiError =>
  new ApiError('CONVERSATION_RUNNING', '对话正在运行，不能同时发送新消息')

/** 请求的 provider/model 不在 DSH 的可用清单里（§3.4）。 */
export const modelUnknown = (message: string, details?: unknown): ApiError =>
  new ApiError('MODEL_UNKNOWN', message, details)

/** 无法从 DSH 获取模型清单，且请求没有指定具体路由。 */
export const modelUnavailable = (message: string, details?: unknown): ApiError =>
  new ApiError('MODEL_UNAVAILABLE', message, details)

/** zod 校验入口：失败统一转成 `VALIDATION_ERROR`（保留 issues 便于前端定位）。 */
export function parseInput<T>(schema: z.ZodType<T>, input: unknown, what = '请求'): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) {
    throw validationError(`${what}校验失败`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
    })
  }
  return parsed.data
}

interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown }
}

function bodyFor(code: string, message: string, details?: unknown): ApiErrorBody {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } }
}

export interface ErrorHandlerOptions {
  /**
   * 前端入口文件（绝对路径）。存在时，非 `/api/` 的 GET 页面请求会回退到它，
   * 让前端 history 路由在直接访问/刷新时也能工作。
   */
  spaIndex?: string
}

/** 判断请求是不是"浏览器要一个页面"：只回退 GET、无扩展名、Accept 含 text/html。 */
function isSpaNavigation(request: FastifyRequest): boolean {
  if (request.method !== 'GET') return false
  const url = request.url.split('?')[0] ?? ''
  if (url.startsWith('/api/')) return false
  if (/\.[A-Za-z0-9]+$/.test(url)) return false
  const accept = request.headers.accept ?? ''
  return accept.includes('text/html')
}

export function registerErrorHandler(
  app: FastifyInstance,
  logger: Logger,
  options: ErrorHandlerOptions = {},
): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    if (options.spaIndex !== undefined && isSpaNavigation(request)) {
      reply.type('text/html; charset=utf-8').send(fs.createReadStream(options.spaIndex))
      return
    }
    reply.status(404).send(bodyFor('NOT_FOUND', `路由不存在: ${request.method} ${request.url}`))
  })

  app.setErrorHandler((error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) => {
    if (reply.raw.headersSent) {
      // 已进入 SSE 流：不能再写 JSON；由路由自己发 message.failed。
      logger.warn('error after response started', { method: request.method, url: request.url, error })
      reply.raw.end()
      return
    }

    if (error instanceof ApiError) {
      if (error.statusCode >= 500) {
        logger.error('request failed', { method: request.method, url: request.url, code: error.code, error })
      }
      reply.status(error.statusCode).send(bodyFor(error.code, error.message, error.details))
      return
    }

    const rawStatus = (error as FastifyError).statusCode
    const status = typeof rawStatus === 'number' ? rawStatus : 500
    if (status < 500) {
      reply.status(status).send(bodyFor('VALIDATION_ERROR', error.message))
      return
    }

    logger.error('unhandled request error', {
      method: request.method,
      url: request.url,
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error,
    })
    reply.status(500).send(bodyFor('INTERNAL_ERROR', '服务器内部错误'))
  })
}
