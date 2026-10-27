/**
 * Fastify 应用装配：错误处理、可选 Bearer 校验、全部路由、可选静态前端与 CORS。
 *
 * 没有用户/角色体系：`INTERNAL_TOKEN` 设置后才对所有 `/api/*` 校验一个共享 Bearer
 * 令牌；默认只监听 127.0.0.1（由业务后端调用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AppContext } from './context.js'
import { ApiError, registerErrorHandler } from './http/errors.js'
import { registerConversationRoutes } from './api/conversations.js'
import { registerCapabilityRoutes } from './api/capabilities.js'
import { registerHealthRoutes } from './api/health.js'
import { registerMcpRoutes } from './api/mcp.js'
import { registerModelRoutes } from './api/models.js'
import { registerProjectRoutes } from './api/projects.js'
import { registerSkillRoutes } from './api/skills.js'

interface FastifyPluginLike {
  default: (instance: FastifyInstance, options?: Record<string, unknown>) => Promise<void>
}

async function registerCors(app: FastifyInstance, origins: string[], logger: AppContext['logger']): Promise<void> {
  if (origins.length === 0) return
  try {
    const plugin = (await import('@fastify/cors')) as unknown as FastifyPluginLike
    await app.register(plugin.default, { origin: origins })
    logger.info('cors enabled', { origins })
  } catch (error) {
    logger.warn('CORS plugin unavailable; browsers will be same-origin only', error)
  }
}

async function registerStatic(
  app: FastifyInstance,
  webDist: string | undefined,
  logger: AppContext['logger'],
): Promise<void> {
  if (webDist === undefined || !fs.existsSync(webDist)) return
  try {
    const plugin = (await import('@fastify/static')) as unknown as FastifyPluginLike
    await app.register(plugin.default, { root: webDist, prefix: '/' })
    logger.info('serving web console from disk', { webDist })
  } catch (error) {
    logger.warn('static plugin unavailable; skipping web console hosting', error)
  }
}

/** Bearer 校验：长度不同直接失败，避免 timingSafeEqual 抛错。 */
function bearerMatches(header: string | undefined, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '')
  if (match === null) return false
  const provided = Buffer.from(match[1] ?? '', 'utf8')
  const target = Buffer.from(expected, 'utf8')
  if (provided.length !== target.length) return false
  return timingSafeEqual(provided, target)
}

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  })

  // 前端是 history 路由的 SPA：非 /api 的页面请求回退到 index.html。
  const spaIndex =
    ctx.config.webDist !== undefined && fs.existsSync(path.join(ctx.config.webDist, 'index.html'))
      ? path.join(ctx.config.webDist, 'index.html')
      : undefined
  registerErrorHandler(app, ctx.logger, spaIndex === undefined ? {} : { spaIndex })

  if (ctx.config.internalToken !== undefined) {
    const expected = ctx.config.internalToken
    app.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/')) return
      if (!bearerMatches(request.headers.authorization, expected)) {
        throw new ApiError('SERVICE_TOKEN_INVALID', '缺少或错误的 Bearer token')
      }
    })
    ctx.logger.info('internal token enabled for /api/*')
  }

  registerHealthRoutes(app, ctx)
  registerSkillRoutes(app, ctx)
  registerCapabilityRoutes(app, ctx)
  registerMcpRoutes(app, ctx)
  registerModelRoutes(app, ctx)
  registerProjectRoutes(app, ctx)
  registerConversationRoutes(app, ctx)

  await registerCors(app, ctx.config.corsOrigins, ctx.logger)
  await registerStatic(app, ctx.config.webDist, ctx.logger)
  return app
}
