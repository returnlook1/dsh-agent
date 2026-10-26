/**
 * `GET /api/models` 与"模型路由来自 DSH"的端到端行为（HTTP 层）。
 *
 * 用种子化清单：默认 `deepseek-official` + `deepseek-flash`/`deepseek-v4-pro`
 * （与 DSH 内建目录一致，但测试完全靠注入，不启动 DSH）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHarness, type TestHarness } from '../helpers.js'

let h: TestHarness

beforeAll(async () => {
  h = await createHarness({ skills: [{ name: 'netcdf-analysis', description: '分析 NetCDF' }] })
})

afterAll(async () => {
  await h.close()
})

describe('GET /api/models', () => {
  it('返回 DSH 侧的 provider 与模型，并给出默认路由', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/models' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as {
      providers: Array<{ id: string; name: string; models: Array<{ id: string; contextWindow?: number }> }>
      default: { provider: string; model: string }
      source: string
    }
    expect(body.providers).toHaveLength(1)
    expect(body.providers[0]).toMatchObject({ id: 'deepseek-official', name: 'DeepSeek' })
    expect(body.providers[0]?.models.map((model) => model.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(body.default).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(body.source).toBe('live')
  })

  it('refresh=1 也能正常返回', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/models?refresh=1' })
    expect(response.statusCode).toBe(200)
  })
})

describe('创建对话时的模型路由', () => {
  it('不传 provider/model → 自动落到 DSH 默认路由', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'p-default' },
    })
    expect(response.statusCode).toBe(201)
    const body = response.json() as { config: { provider: string; model: string } }
    expect(body.config.provider).toBe('deepseek-official')
    expect(body.config.model).toBe('deepseek-flash')
  })

  it('客户端指定 provider/model 会被忽略（由 DSH 统一管理）', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/conversations',
      payload: { projectId: 'p-explicit', provider: 'openai', model: 'gpt-4o' },
    })
    expect(response.statusCode).toBe(201)
    const config = (response.json() as { config: { provider: string; model: string; routeSource: string } }).config
    expect(config.provider).toBe('deepseek-official')
    expect(config.model).toBe('deepseek-flash')
    expect(config.routeSource).toBe('catalog-first')
  })

  it('项目配置同样不接受 provider/model（写不进去）', async () => {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/api/projects/p-bad3/agent-config',
      payload: { skills: [], model: 'not-a-model' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { model: string }
    expect(body.model).toBe('deepseek-flash')
  })
})

describe('模型清单不可用时的降级', () => {
  it('空清单 → /api/models 返回 cache 语义 + error，创建对话 503', async () => {
    const bare = await createHarness({ providers: [] })
    try {
      const catalog = await bare.app.inject({ method: 'GET', url: '/api/models' })
      expect(catalog.statusCode).toBe(200)
      const body = catalog.json() as { providers: unknown[]; source: string; error?: string }
      expect(body.providers).toEqual([])
      expect(body.source).not.toBe('live')
      expect(typeof body.error).toBe('string')

      const created = await bare.app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { projectId: 'p1' },
      })
      expect(created.statusCode).toBe(503)
      expect((created.json() as { error: { code: string } }).error.code).toBe('MODEL_UNAVAILABLE')

      // 客户端也不再能靠"显式给路由"绕过：模型路由完全由 DSH 决定
      const explicit = await bare.app.inject({
        method: 'POST',
        url: '/api/conversations',
        payload: { projectId: 'p2', provider: 'deepseek-official', model: 'deepseek-flash' },
      })
      expect(explicit.statusCode).toBe(503)
    } finally {
      await bare.close()
    }
  })
})
