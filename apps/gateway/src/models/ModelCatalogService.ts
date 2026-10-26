/**
 * 模型清单服务：内存缓存 + 磁盘缓存 + 默认路由 + 校验。
 *
 * 行为：
 * - 启动时 `ensure()` 先读磁盘缓存（上次成功结果），再尝试向 DSH 重新发现；
 * - `GET /api/models?refresh=1` 强制重新发现；
 * - 发现失败时降级到缓存（`source: 'cache'`）或 `unavailable`，并把原因带出去；
 * - 默认路由 = 第一个有模型的 provider 的首个模型（DSH 的 provider 顺序即其注册顺序）。
 *
 * 这里**不写死任何 provider/model 名称**：权威来源永远是 DSH 运行时。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  hasUsableRoute,
  type AgentConfig,
  type ModelCatalogResponse,
  type ProviderOption,
} from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { DiscoveryResult, ModelDiscovery } from './ModelDiscovery.js'

/** 只依赖 `discover()`：便于单测注入假发现，不启动 DSH。 */
export type ModelDiscoveryLike = Pick<ModelDiscovery, 'discover'>

export interface ModelCatalogServiceDeps {
  discovery: ModelDiscoveryLike | undefined
  logger: Logger
  /** 磁盘缓存路径（`data/models.json`）。 */
  cachePath: string
  /** 内存缓存有效期；`refresh` 时忽略。 */
  ttlMs?: number
  now?: () => number
}

export interface ResolvedRoute {
  provider: string
  model: string
}

export class ModelCatalogService {
  private current: ModelCatalogResponse | undefined
  private inflight: Promise<ModelCatalogResponse> | undefined
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly deps: ModelCatalogServiceDeps) {
    this.now = deps.now ?? (() => Date.now())
    this.ttlMs = deps.ttlMs ?? 60_000
  }

  /** 同步读取磁盘缓存（启动时调用一次，保证默认路由立即可用）。 */
  loadCache(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.deps.cachePath, 'utf8')) as ModelCatalogResponse
      if (Array.isArray(raw.providers) && raw.providers.length > 0) {
        this.current = {
          providers: raw.providers.map(normaliseProvider),
          default: raw.default ?? defaultRouteOf(raw.providers),
          discoveredAt: typeof raw.discoveredAt === 'number' ? raw.discoveredAt : 0,
          source: 'cache',
        }
        this.deps.logger.info('model catalog loaded from cache', {
          providers: this.current.providers.length,
          discoveredAt: this.current.discoveredAt,
        })
      }
    } catch {
      /* 没有缓存是正常状态 */
    }
  }

  /** 最近一次已知清单（可能是缓存）；未就绪时 undefined。 */
  peek(): ModelCatalogResponse | undefined {
    return this.current
  }

  /** 是否有可用的 provider/model 路由。 */
  hasRoute(): boolean {
    return this.current !== undefined && hasUsableRoute(this.current)
  }

  /** 默认路由；清单不可用时抛错（上层转 503）。 */
  defaultRoute(): ResolvedRoute {
    const catalog = this.current
    if (catalog === undefined || !hasUsableRoute(catalog)) {
      throw new Error('模型清单不可用：尚未从 DSH 获取到任何 provider/model')
    }
    return { ...catalog.default }
  }

  /**
   * 取清单：内存新鲜则直接返回，否则重新发现。
   * @param options.refresh - 强制重新发现
   */
  async get(options: { refresh?: boolean } = {}): Promise<ModelCatalogResponse> {
    const cached = this.current
    const fresh =
      cached !== undefined &&
      cached.source === 'live' &&
      this.now() - cached.discoveredAt < this.ttlMs
    if (!options.refresh && fresh) return cached
    return await this.refresh()
  }

  /** 启动时调用：先读缓存，再尽力刷新一次（失败只记日志）。 */
  async ensure(): Promise<void> {
    this.loadCache()
    try {
      await this.refresh()
    } catch (error) {
      this.deps.logger.warn('initial model discovery failed; continuing with cache', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** 重新发现（并发调用合并成一次）。 */
  async refresh(): Promise<ModelCatalogResponse> {
    if (this.inflight !== undefined) return await this.inflight
    const task = this.doRefresh()
    this.inflight = task
    try {
      return await task
    } finally {
      this.inflight = undefined
    }
  }

  private async doRefresh(): Promise<ModelCatalogResponse> {
    if (this.deps.discovery === undefined) {
      const previous = this.current
      this.current = {
        providers: previous?.providers ?? [],
        default: previous?.default ?? { provider: '', model: '' },
        discoveredAt: previous?.discoveredAt ?? 0,
        source: previous === undefined ? 'unavailable' : 'cache',
        error: '模型发现已禁用（AGENT_SERVICE_MODEL_DISCOVERY=off）',
      }
      return this.current
    }

    try {
      const result: DiscoveryResult = await this.deps.discovery.discover()
      const providers = result.providers.map(normaliseProvider)
      const catalog: ModelCatalogResponse = {
        providers,
        default: defaultRouteOf(providers),
        discoveredAt: result.probedAt,
        source: hasUsableRoute({ providers }) ? 'live' : 'cache',
      }
      if (!hasUsableRoute({ providers })) {
        catalog.error = 'DSH 报告了 provider，但没有任何可用模型（检查凭据或 baseURL）'
      }
      this.current = catalog
      this.writeCache(catalog)
      return catalog
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.deps.logger.warn('model discovery failed', { error: reason })
      const previous = this.current
      this.current = {
        providers: previous?.providers ?? [],
        default: previous?.default ?? { provider: '', model: '' },
        discoveredAt: previous?.discoveredAt ?? 0,
        source: previous === undefined ? 'unavailable' : 'cache',
        error: reason,
      }
      return this.current
    }
  }

  private writeCache(catalog: ModelCatalogResponse): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.cachePath), { recursive: true })
      const temp = `${this.deps.cachePath}.tmp-${process.pid}`
      fs.writeFileSync(temp, `${JSON.stringify({ ...catalog, source: 'live' }, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, this.deps.cachePath)
    } catch (error) {
      this.deps.logger.warn('model catalog cache write failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 校验并补全配置里的模型路由：
   * - 空值 → 用清单默认路由；
   * - 非空 → 必须在清单里（否则 400 MODEL_UNKNOWN）；
   * - 清单不可用 → 允许显式值通过（运行时会给更精确的错误），空值则 503。
   * @param config - 待校验配置
   * @param request - 抛错用的错误工厂（避免这里直接依赖 http 层）
   */
  resolveConfig(
    config: AgentConfig,
    errors: {
      unknown: (message: string, details?: unknown) => Error
      unavailable: (message: string) => Error
    },
  ): AgentConfig {
    const catalog = this.current
    let provider = config.provider
    let model = config.model

    if ((provider.length === 0 || model.length === 0) && catalog !== undefined && hasUsableRoute(catalog)) {
      provider = provider.length === 0 ? catalog.default.provider : provider
      model = model.length === 0 ? catalog.default.model : model
    }

    if (catalog === undefined || !hasUsableRoute(catalog)) {
      if (provider.length === 0 || model.length === 0) {
        throw errors.unavailable(
          `模型清单不可用，无法选择默认模型${catalog?.error === undefined ? '' : `（${catalog.error}）`}`,
        )
      }
      return { ...config, provider, model }
    }

    const providerEntry = catalog.providers.find((item) => item.id === provider)
    if (providerEntry === undefined) {
      throw errors.unknown(`未知 provider: ${provider}`, {
        provider,
        model,
        available: catalog.providers.map((item) => ({ id: item.id, models: item.models.map((m) => m.id) })),
      })
    }
    if (!providerEntry.models.some((item) => item.id === model)) {
      throw errors.unknown(`provider ${provider} 下没有模型 ${model}`, {
        provider,
        model,
        availableModels: providerEntry.models.map((item) => item.id),
      })
    }
    return { ...config, provider, model }
  }
}

/** 默认路由：第一个有模型的 provider 的首个模型。 */
export function defaultRouteOf(providers: readonly ProviderOption[]): ResolvedRoute {
  for (const provider of providers) {
    if (provider.models.length > 0) {
      return { provider: provider.id, model: provider.models[0]!.id }
    }
  }
  return { provider: '', model: '' }
}

function normaliseProvider(provider: ProviderOption): ProviderOption {
  return {
    id: provider.id,
    name: provider.name.length > 0 ? provider.name : provider.id,
    models: provider.models,
    ...(provider.error === undefined ? {} : { error: provider.error }),
  }
}
