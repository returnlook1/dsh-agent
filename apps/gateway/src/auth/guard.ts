/**
 * Fastify preHandler 认证守卫。
 *
 * 认证与会话/资源归属是两层：这里只解决"是谁"，归属过滤在仓库层用
 * `user_id` 条件完成。`requireAdmin` 只保护管理端路由。
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'
import type { Role, UserDto } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { UsersRepository } from '../repositories/users.js'
import { unauthorized, forbidden } from '../http/errors.js'
import { verifyToken } from './tokens.js'

export interface AuthContext {
  user: UserDto
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext
  }
}

export interface AuthGuardDeps {
  users: UsersRepository
  secret: string
  logger: Logger
}

export interface AuthGuards {
  authenticate: preHandlerHookHandler
  requireAdmin: preHandlerHookHandler
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization
  if (typeof header !== 'string') return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]
}

export function createAuthGuards(deps: AuthGuardDeps): AuthGuards {
  const authenticate: preHandlerHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = bearerToken(request)
    if (token === undefined) throw unauthorized('缺少 Authorization: Bearer 令牌')

    const payload = verifyToken(token, deps.secret)
    if (payload === undefined) throw unauthorized('令牌无效或已过期')

    // 每次请求都回查用户：令牌有效但用户被删除/降权时立即失效。
    const row = deps.users.findById(payload.sub)
    if (row === undefined) {
      deps.logger.warn('token subject no longer exists', { userId: payload.sub })
      throw unauthorized('令牌对应用户不存在')
    }
    if (row.role !== payload.role) throw unauthorized('令牌角色已变更，请重新登录')

    request.auth = { user: deps.users.toDto(row) }
  }

  const requireAdmin: preHandlerHookHandler = async (request: FastifyRequest, _reply: FastifyReply) => {
    const role: Role | undefined = request.auth?.user.role
    if (role === undefined) throw unauthorized()
    if (role !== 'admin') throw forbidden('需要管理员权限')
  }

  return { authenticate, requireAdmin }
}

/** 路由内获取已认证用户（守卫已跑过，缺失即编程错误）。 */
export function requireAuth(request: FastifyRequest): AuthContext {
  const auth = request.auth
  if (auth === undefined) throw unauthorized()
  return auth
}
