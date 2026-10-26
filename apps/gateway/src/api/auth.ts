/** 认证路由。 */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { LoginResponse } from '@agent-studio/shared'
import type { AppContext } from '../context.js'
import type { AuthGuards } from '../auth/guard.js'
import { fakeVerifyPassword, verifyPassword } from '../auth/passwords.js'
import { issueToken } from '../auth/tokens.js'
import { parseInput, unauthorized } from '../http/errors.js'

const loginSchema = z.object({
  username: z.string().min(1).max(80),
  password: z.string().min(1).max(256),
})

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, guards: AuthGuards): void {
  app.post('/api/auth/login', async (request, reply) => {
    const body = parseInput(loginSchema, request.body, '登录请求')
    const row = ctx.repos.users.findByUsername(body.username)
    if (row === undefined) {
      // 账号不存在也执行一次等价开销的哈希，减少时序差异。
      fakeVerifyPassword(body.password)
      throw unauthorized('用户名或密码错误')
    }
    if (!verifyPassword(body.password, row.password_hash)) {
      throw unauthorized('用户名或密码错误')
    }
    const issued = issueToken(
      { id: row.id, role: row.role },
      ctx.config.authSecret,
      ctx.config.tokenTtlHours * 3_600_000,
    )
    const response: LoginResponse = {
      token: issued.token,
      user: ctx.repos.users.toDto(row),
      expiresAt: issued.expiresAt,
    }
    reply.send(response)
  })

  app.get('/api/auth/me', { preHandler: [guards.authenticate] }, async (request, reply) => {
    // 契约：GET /api/auth/me -> UserDto（web 端按 UserDto 解析，不能再包一层 { user }）
    const user = request.auth?.user
    if (user === undefined) throw unauthorized('未登录')
    reply.send(user)
  })
}
