import fs from 'node:fs'
/**
 * 统一错误响应：`{ error: { code, message, details? } }`。
 *
 * 路由/服务层只抛 `ApiError`；其它异常由 Fastify 错误处理器记录并降级为
 * `INTERNAL_ERROR`（不把内部堆栈返回给客户端）。
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { z } from 'zod'
import type { Logger } from '../logger.js'

export type ApiErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'RUNTIME_ERROR'
  | 'INTERNAL_ERROR'

export const ERROR_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  RUNTIME_ERROR: 502,
  INTERNAL_ERROR: 500,
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

export const unauthorized = (message = '未登录或令牌无效'): ApiError => new ApiError('UNAUTHORIZED', message)

export const forbidden = (message = '没有权限执行该操作'): ApiError => new ApiError('FORBIDDEN', message)

export const notFound = (message = '资源不存在'): ApiError => new ApiError('NOT_FOUND', message)

export const validationError = (message: string, details?: unknown): ApiError =>
  new ApiError('VALIDATION_ERROR', message, details)

export const conflict = (message: string, details?: unknown): ApiError => new ApiError('CONFLICT', message, details)

export const rateLimited = (message: string, details?: unknown): ApiError =>
  new ApiError('RATE_LIMITED', message, details)

export const runtimeError = (message: string, details?: unknown): ApiError =>
  new ApiError('RUNTIME_ERROR', message, details)

/** zod 校验入口：失败统一转成 VALIDATION_ERROR（保留 issues 便于前端定位）。 */
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

function bodyFor(code: ApiErrorCode, message: string, details?: unknown): { error: { code: string; message: string; details?: unknown } } {
  return details === undefined ? { error: { code, message } } : { error: { code, message, details } }
}

export interface ErrorHandlerOptions {
  /**
   * 前端入口文件（绝对路径）。存在时，非 `/api/` 的 GET 页面请求会回退到它，
   * 让 Vue Router 的 history 路由在直接访问/刷新时也能工作。
   */
  spaIndex?: string
}

/**
 * 判断一个请求是不是"浏览器要一个页面"：
 * 只回退 GET、路径不带扩展名、Accept 里含 text/html，避免把缺失的静态资源也
 * 变成 200 的 index.html（那会让排查缓存/构建问题变得很痛苦）。
 */
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
