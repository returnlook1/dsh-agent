/**
 * 无状态访问令牌：`base64url(JSON payload) + '.' + base64url(HMAC-SHA256(secret, payload))`。
 *
 * 不使用 JWT 库：载荷只有 `sub/role/exp/iat`，签名与比较逻辑必须可审计。
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Role } from '@agent-studio/shared'

export interface AuthTokenPayload {
  /** 用户 id。 */
  sub: string
  role: Role
  /** 过期时间（毫秒时间戳）。 */
  exp: number
  /** 签发时间（毫秒时间戳）。 */
  iat: number
}

export interface IssuedToken {
  token: string
  expiresAt: number
}

function sign(payloadSegment: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url')
}

export function issueToken(
  subject: { id: string; role: Role },
  secret: string,
  ttlMs: number,
  nowMs: number = Date.now(),
): IssuedToken {
  const payload: AuthTokenPayload = {
    sub: subject.id,
    role: subject.role,
    iat: nowMs,
    exp: nowMs + ttlMs,
  }
  const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const token = `${payloadSegment}.${sign(payloadSegment, secret)}`
  return { token, expiresAt: payload.exp }
}

function isPayload(value: unknown): value is AuthTokenPayload {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.sub === 'string' &&
    (record.role === 'admin' || record.role === 'user') &&
    typeof record.exp === 'number' &&
    typeof record.iat === 'number'
  )
}

/** 校验签名与过期时间；任何异常都返回 undefined（调用方统一 401）。 */
export function verifyToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): AuthTokenPayload | undefined {
  const parts = token.split('.')
  if (parts.length !== 2) return undefined
  const [payloadSegment, signature] = parts
  if (payloadSegment === undefined || signature === undefined) return undefined

  const expected = Buffer.from(sign(payloadSegment, secret), 'utf8')
  const actual = Buffer.from(signature, 'utf8')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
  if (!isPayload(payload)) return undefined
  if (payload.exp <= nowMs) return undefined
  if (payload.iat > nowMs + 60_000) return undefined
  return payload
}
