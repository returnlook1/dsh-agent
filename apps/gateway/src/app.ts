/** Fastify 应用装配：错误处理、鉴权守卫、全部路由、可选静态前端与 CORS。 */
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppContext } from './context.js'
import { createAuthGuards } from './auth/guard.js'
import { registerErrorHandler } from './http/errors.js'
import { registerAuthRoutes } from './api/auth.js'
import { registerAgentRoutes } from './api/agents.js'
import { registerSessionRoutes } from './api/sessions.js'
import { registerApprovalRoutes } from './api/approvals.js'
import { registerMcpRoutes } from './api/mcp.js'
import { registerAuditRoutes } from './api/audit.js'
import { registerRuntimeRoutes } from './api/runtime.js'
import { registerHealthRoutes } from './api/health.js'
import fs from 'node:fs'
import path from 'node:path'

interface FastifyPluginLike {
  default: (instance: FastifyInstance, options?: Record<string, unknown>) => Promise<void>
}

async function registerCors(app: FastifyInstance, logger: AppContext['logger']): Promise<void> {
  try {
    // 动态导入：CORS 只是浏览器开发便利，不应阻塞网关启动。
    const moduleName = '@fastify/cors'
    const plugin = (await import(moduleName)) as FastifyPluginLike
    await app.register(plugin.default, { origin: true })
  } catch (error) {
    logger.warn('CORS plugin unavailable; skipping', error)
  }
}

async function registerStatic(app: FastifyInstance, webDist: string | undefined, logger: AppContext['logger']): Promise<void> {
  if (webDist === undefined || !fs.existsSync(webDist)) return
  try {
    const moduleName = '@fastify/static'
    const plugin = (await import(moduleName)) as FastifyPluginLike
    await app.register(plugin.default, { root: webDist, prefix: '/' })
    logger.info('serving web console from disk', { webDist })
  } catch (error) {
    logger.warn('static plugin unavailable; skipping web console hosting', error)
  }
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  })

  // 前端是 history 路由的 SPA：非 /api 的页面请求回退到 index.html，
  // 直接访问 /agents/:id/edit 或刷新聊天页才不会 404。
  const spaIndex =
    ctx.config.webDist !== undefined && fs.existsSync(path.join(ctx.config.webDist, 'index.html'))
      ? path.join(ctx.config.webDist, 'index.html')
      : undefined
  registerErrorHandler(app, ctx.logger, spaIndex === undefined ? {} : { spaIndex })
  const guards = createAuthGuards({
    users: ctx.repos.users,
    secret: ctx.config.authSecret,
    logger: ctx.logger,
  })

  registerHealthRoutes(app, ctx)
  registerAuthRoutes(app, ctx, guards)
  registerAgentRoutes(app, ctx, guards)
  registerSessionRoutes(app, ctx, guards)
  registerApprovalRoutes(app, ctx, guards)
  registerMcpRoutes(app, ctx, guards)
  registerAuditRoutes(app, ctx, guards)
  registerRuntimeRoutes(app, ctx, guards)

  await registerCors(app, ctx.logger)
  await registerStatic(app, ctx.config.webDist, ctx.logger)
  return app
}
