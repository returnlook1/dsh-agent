/**
 * HTTP 传输层。
 *
 * 只负责：拼 URL、注入 Bearer token、统一错误形状、401 通知。
 * 业务语义一律放在 `agent-api.ts` 里，页面不直接 fetch。
 */
import type { ApiError as ApiErrorPayload } from '@agent-studio/shared'

export const TOKEN_STORAGE_KEY = 'agent-studio.token'
export const USER_STORAGE_KEY = 'agent-studio.user'
export const EXPIRES_STORAGE_KEY = 'agent-studio.expires-at'
export const UNAUTHORIZED_EVENT = 'agent-studio:unauthorized'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

/** 网关错误（含网络不可达）。 */
export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface QueryValue {
  [key: string]: string | number | boolean | undefined | null
}

export interface RequestOptions {
  query?: QueryValue
  body?: unknown
  signal?: AbortSignal
  /** 追加的请求头，例如 SSE 的 Accept。 */
  headers?: Record<string, string>
  /** 允许页面自定义超时，默认 20s。 */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 20_000

function buildUrl(path: string, query?: QueryValue): string {
  const normalized = path.startsWith('/') ? path : `/${path}`
  const base = `/api${normalized}`
  if (!query) return base
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs.length > 0 ? `${base}?${qs}` : base
}

export function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === 'AbortError'
  return error instanceof Error && error.name === 'AbortError'
}

/** 供上层区分"用户主动停止"与真正的失败。 */
export function isAbortedRequest(error: unknown): boolean {
  return isAbortError(error) || (error instanceof HttpError && error.code === 'ABORTED')
}

/**
 * 底层 fetch。SSE 与普通 JSON 请求共用，保证鉴权与 401 处理只有一份实现。
 */
export async function apiFetch(path: string, init: RequestInit, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  const token = readStoredToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  headers.set('Accept', options.headers?.Accept ?? headers.get('Accept') ?? 'application/json')

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const upstream = init.signal
  const abortFromUpstream = (): void => controller.abort()
  if (upstream !== null && upstream !== undefined) {
    if (upstream.aborted) controller.abort()
    else upstream.addEventListener('abort', abortFromUpstream, { once: true })
  }
  const timeoutTimer = timeoutMs > 0 ? window.setTimeout(() => controller.abort(), timeoutMs) : null

  try {
    return await fetch(buildUrl(path, options.query), { ...init, headers, signal: controller.signal })
  } catch (error) {
    if (isAbortError(error)) {
      throw new HttpError(0, 'ABORTED', '请求已取消')
    }
    throw new HttpError(0, 'NETWORK_ERROR', '无法连接服务网关，请确认网关已启动并监听 8787 端口')
  } finally {
    if (timeoutTimer !== null) window.clearTimeout(timeoutTimer)
    upstream?.removeEventListener('abort', abortFromUpstream)
  }
}

async function toHttpError(response: Response): Promise<HttpError> {
  let code = `HTTP_${response.status}`
  let message = ''
  let details: unknown
  const raw = await response.text().catch(() => '')
  if (raw.length > 0) {
    try {
      // JSON 边界：网关返回 ApiError 或任意错误对象。
      const payload = JSON.parse(raw) as ApiErrorPayload | { message?: string; error?: string }
      if (payload !== null && typeof payload === 'object' && 'error' in payload && payload.error !== null) {
        const nested = payload.error
        if (typeof nested === 'object') {
          code = nested.code || code
          message = nested.message || message
          details = nested.details
        } else if (typeof nested === 'string') {
          message = nested
        }
      } else if ('message' in payload && typeof payload.message === 'string') {
        message = payload.message
      }
    } catch {
      message = raw.slice(0, 200)
    }
  }
  if (message.length === 0) message = defaultMessageForStatus(response.status)
  return new HttpError(response.status, code, message, details)
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return '请求参数不合法'
    case 401:
      return '登录已失效，请重新登录'
    case 403:
      return '当前账号没有该操作权限'
    case 404:
      return '请求的资源不存在'
    case 409:
      return '资源状态冲突，请刷新后重试'
    case 429:
      return '请求过于频繁，请稍后再试'
    default:
      return status >= 500 ? '网关处理失败，请查看网关日志' : '请求失败'
  }
}

/** 普通 JSON 请求。 */
export async function apiRequest<T>(
  method: HttpMethod,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const init: RequestInit = { method }
  if (options.body !== undefined) init.body = JSON.stringify(options.body)
  const response = await apiFetch(path, init, options)
  // 登录失败本身就是 401，不能触发"登录已失效"的全局登出跳转。
  if (response.status === 401 && !path.startsWith('/auth/login')) {
    window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
  }
  if (!response.ok) throw await toHttpError(response)
  if (response.status === 204) return undefined as T
  const text = await response.text()
  if (text.length === 0) return undefined as T
  // JSON 边界：响应体形状由共享 DTO 约束，运行时只做一次性断言。
  return JSON.parse(text) as T
}

/** 打开 SSO/SSE 流之前的响应级校验（失败时抛出与 JSON 请求一致的错误）。 */
export async function openEventStream(
  path: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<Response> {
  const response = await apiFetch(
    path,
    { method: 'POST', body: JSON.stringify(body), headers: { Accept: 'text/event-stream' } },
    { ...options, timeoutMs: options.timeoutMs ?? 0 },
  )
  if (response.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
  if (!response.ok) throw await toHttpError(response)
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!contentType.includes('text/event-stream') || response.body === null) {
    throw new HttpError(502, 'SSE_UNAVAILABLE', '网关未返回事件流，请确认网关 SSE 通道可用')
  }
  return response
}
