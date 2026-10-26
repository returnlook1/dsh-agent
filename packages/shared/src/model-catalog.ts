/**
 * 模型清单：**从 DSH 读取**，不在服务里写死。
 *
 * `0.2.1-rc.3` 的 provider 由 Cordis 插件在运行时注册，模型目录由 adapter 提供
 * （官方端点下是 `/models` 列表，非官方 endpoint 下是内建目录）。服务启动后用
 * 一个探针插件向真实运行时询问 `ctx.llm.listProviders()` / `listModels()`，
 * 结果缓存在内存与 `data/models.json`。
 *
 * 因此：部署侧新增/更换 Provider、换 baseURL、换模型目录，服务无需改代码。
 */

/** 一个可选模型。 */
export interface ModelOption {
  /** 传给 DSH `initialize.model` 的模型 id。 */
  id: string
  /** 展示名。 */
  name: string
  description?: string
  /** 上下文窗口（token），adapter 未披露时缺省。 */
  contextWindow?: number
}

/** 一个可选 Provider。 */
export interface ProviderOption {
  /** 传给 DSH `initialize.provider` 的 provider id。 */
  id: string
  name: string
  models: ModelOption[]
  /** 该 provider 的模型清单获取失败时的原因（不会让整个清单失败）。 */
  error?: string
}

/** 清单来源。 */
export type ModelCatalogSource = 'live' | 'cache' | 'unavailable'

export interface ModelCatalogResponse {
  providers: ProviderOption[]
  /**
   * 默认路由。优先级：DSH 配置的 `agent-default-model` → 清单里第一个有模型的 provider。
   * 前端只展示，不可修改（供应商与模型由 DSH 统一管理）。
   */
  default: {
    provider: string
    model: string
  }
  /** 默认路由来自哪里。 */
  defaultSource: 'dsh-default-model' | 'catalog-first'
  /** DSH 配置了默认路由、但当前运行时清单里没有它时的说明（排障用）。 */
  preferredUnavailable?: {
    provider: string
    model: string
    reason: string
  }
  /** 清单生成时间。 */
  discoveredAt: number
  source: ModelCatalogSource
  /** source=unavailable / cache 时的原因。 */
  error?: string
}

/** 判断某个 provider/model 是否在清单里（供服务端校验使用）。 */
export function findModel(
  catalog: Pick<ModelCatalogResponse, 'providers'>,
  provider: string,
  model: string,
): ModelOption | undefined {
  return catalog.providers.find((item) => item.id === provider)?.models.find((item) => item.id === model)
}

/** 清单里是否有可用模型（没有时服务应拒绝创建对话）。 */
export function hasUsableRoute(catalog: Pick<ModelCatalogResponse, 'providers'>): boolean {
  return catalog.providers.some((provider) => provider.models.length > 0)
}
