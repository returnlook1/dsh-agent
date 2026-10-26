/**
 * 模型清单服务：默认路由、校验、缓存与降级。
 *
 * 全部用注入的假发现，**不启动 DSH**（真实探针由 `npm run check:runtime` / e2e 覆盖）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderOption } from '@agent-studio/shared'
import { agentConfigSchema } from '@agent-studio/shared'
import { ModelCatalogService, defaultRouteOf } from '../../src/models/ModelCatalogService.js'
import { makeTempDir } from '../helpers.js'
import { silentLogger } from '../../src/logger.js'

const PROVIDERS: ProviderOption[] = [
  { id: 'p-empty', name: '空 Provider', models: [] },
  {
    id: 'p-main',
    name: '主 Provider',
    models: [
      { id: 'm-1', name: '模型一', contextWindow: 1_000_000 },
      { id: 'm-2', name: '模型二', description: '更强' },
    ],
  },
]

function errors() {
  return {
    unknown: (message: string, details?: unknown) => Object.assign(new Error(message), { code: 'MODEL_UNKNOWN', details }),
    unavailable: (message: string) => Object.assign(new Error(message), { code: 'MODEL_UNAVAILABLE' }),
  }
}

function config(overrides: Partial<{ provider: string; model: string }> = {}) {
  return agentConfigSchema.parse({ ...overrides })
}

function service(options: {
  root: string
  providers?: ProviderOption[]
  fail?: boolean
  calls?: { count: number }
}): ModelCatalogService {
  return new ModelCatalogService({
    discovery: {
      discover: async () => {
        if (options.calls !== undefined) options.calls.count += 1
        if (options.fail === true) throw new Error('probe exploded')
        return { providers: options.providers ?? PROVIDERS, probedAt: Date.now() }
      },
    },
    logger: silentLogger,
    cachePath: path.join(options.root, 'data', 'models.json'),
    ttlMs: 60_000,
  })
}

describe('defaultRouteOf', () => {
  it('取第一个「有模型」的 provider 的首个模型', () => {
    expect(defaultRouteOf(PROVIDERS)).toEqual({ provider: 'p-main', model: 'm-1' })
  })

  it('全都没有模型时返回空路由', () => {
    expect(defaultRouteOf([{ id: 'x', name: 'x', models: [] }])).toEqual({ provider: '', model: '' })
  })
})

describe('ModelCatalogService.resolveConfig', () => {
  let models: ModelCatalogService
  let root: string

  beforeEach(async () => {
    root = makeTempDir('models-')
    models = service({ root })
    await models.ensure()
  })

  it('空 provider/model → 用 DSH 清单里的默认路由', () => {
    const resolved = models.resolveConfig(config(), errors())
    expect(resolved).toMatchObject({ provider: 'p-main', model: 'm-1' })
  })

  it('显式且合法的路由原样保留', () => {
    const resolved = models.resolveConfig(config({ provider: 'p-main', model: 'm-2' }), errors())
    expect(resolved).toMatchObject({ provider: 'p-main', model: 'm-2' })
  })

  it('未知 provider → MODEL_UNKNOWN，并带上可用清单', () => {
    expect(() => models.resolveConfig(config({ provider: 'nope', model: 'm-1' }), errors())).toThrowError(
      /未知 provider/,
    )
    try {
      models.resolveConfig(config({ provider: 'nope', model: 'm-1' }), errors())
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MODEL_UNKNOWN')
      expect((error as { details?: { available?: unknown } }).details?.available).toBeDefined()
    }
  })

  it('provider 合法但模型不存在 → MODEL_UNKNOWN', () => {
    try {
      models.resolveConfig(config({ provider: 'p-main', model: 'ghost' }), errors())
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('MODEL_UNKNOWN')
      expect((error as { details?: { availableModels?: string[] } }).details?.availableModels).toEqual(['m-1', 'm-2'])
    }
  })

  it('只给了 model、没给 provider → 保留 model 并用默认 provider', () => {
    const resolved = models.resolveConfig(config({ model: 'm-2' }), errors())
    expect(resolved).toMatchObject({ provider: 'p-main', model: 'm-2' })
  })

  it('清单不可用 + 空路由 → MODEL_UNAVAILABLE', () => {
    const bare = service({ root: makeTempDir('models-bare-'), fail: true })
    return bare.ensure().then(() => {
      try {
        bare.resolveConfig(config(), errors())
        throw new Error('应当抛错')
      } catch (error) {
        expect((error as { code?: string }).code).toBe('MODEL_UNAVAILABLE')
      }
    })
  })

  it('清单不可用 + 显式路由 → 放行（由运行时给出更精确的错误）', async () => {
    const bare = service({ root: makeTempDir('models-bare2-'), fail: true })
    await bare.ensure()
    const resolved = bare.resolveConfig(config({ provider: 'p-main', model: 'm-1' }), errors())
    expect(resolved).toMatchObject({ provider: 'p-main', model: 'm-1' })
  })
})

describe('ModelCatalogService 缓存与刷新', () => {
  it('发现成功后写盘，新实例可直接从缓存启动', async () => {
    const root = makeTempDir('models-cache-')
    const first = service({ root })
    await first.ensure()
    expect(fs.existsSync(path.join(root, 'data', 'models.json'))).toBe(true)

    const second = service({ root, fail: true })
    second.loadCache()
    expect(second.peek()?.source).toBe('cache')
    expect(second.peek()?.providers.map((item) => item.id)).toEqual(['p-empty', 'p-main'])
    expect(second.defaultRoute()).toEqual({ provider: 'p-main', model: 'm-1' })
  })

  it('TTL 内不重复发现，refresh 强制重新发现', async () => {
    const root = makeTempDir('models-ttl-')
    const calls = { count: 0 }
    const models = service({ root, calls })
    await models.get()
    await models.get()
    expect(calls.count).toBe(1)
    await models.get({ refresh: true })
    expect(calls.count).toBe(2)
  })

  it('发现失败时降级到上一次成功结果并带上 error', async () => {
    const root = makeTempDir('models-degrade-')
    let fail = false
    const models = new ModelCatalogService({
      discovery: {
        discover: async () => {
          if (fail) throw new Error('probe exploded')
          return { providers: PROVIDERS, probedAt: Date.now() }
        },
      },
      logger: silentLogger,
      cachePath: path.join(root, 'data', 'models.json'),
      ttlMs: 0,
    })
    await models.get()
    fail = true
    const degraded = await models.get({ refresh: true })
    expect(degraded.source).toBe('cache')
    expect(degraded.error).toMatch(/probe exploded/)
    expect(degraded.providers).toHaveLength(2)
  })

  it('发现被禁用时返回 unavailable', async () => {
    const models = new ModelCatalogService({
      discovery: undefined,
      logger: silentLogger,
      cachePath: path.join(makeTempDir('models-off-'), 'models.json'),
    })
    const catalog = await models.get()
    expect(catalog.source).toBe('unavailable')
    expect(models.hasRoute()).toBe(false)
  })
})

describe('ModelCatalogService 日志', () => {
  it('发现失败只记 warn，不抛给调用方', async () => {
    const warn = vi.fn()
    const models = new ModelCatalogService({
      discovery: { discover: async () => Promise.reject(new Error('nope')) },
      logger: { ...silentLogger, warn } as unknown as typeof silentLogger,
      cachePath: path.join(makeTempDir('models-warn-'), 'models.json'),
    })
    await expect(models.ensure()).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
