/**
 * 模型清单探针（运行在 **DSH 子进程内**）。
 *
 * 职责：向 DSH 自己的 LLM 注册表询问"有哪些 provider、每个 provider 有哪些模型"，
 * 写到 `AGENT_SERVICE_MODEL_PROBE_OUT` 指向的 JSON 文件，然后退出进程。
 *
 * 为什么需要它：`0.2.1-rc.3` 的 SDK 协议里没有"列模型"的方法，provider 与模型目录由
 * Cordis 插件在运行时注册（官方端点走 `/models` 列表，非官方端点用 adapter 内建目录）。
 * 在服务进程里硬编码一张表会立刻过时，所以让 DSH 自己回答。
 *
 * 约束（与业务工具插件相同）：只允许 Node 内置模块的运行时 import，
 * `@deepseek-ai/*` 一律 `import type`，避免在子进程里加载第二份 Cordis。
 */
import { writeFileSync } from 'node:fs'

/** Cordis 插件名。 */
export const name = 'agent-service-model-probe'

/** 需要 LLM 注册表就绪。 */
export const inject: string[] = ['llm']

/** 单 provider 模型查询上限（官方端点可能要发一次 `/models` 请求）。 */
const PER_PROVIDER_TIMEOUT_MS = 15_000

/**
 * 等待 provider 注册完成的上限。
 *
 * 探针的 `inject: ['llm']` 只保证 **LLM 服务**已就绪，不保证各 adapter 插件
 * （`llm-deepseek-api-key` 等）已经激活——DSH 的插件激活顺序由服务依赖驱动，
 * 探针往往先于 provider 插件 apply。因此这里必须轮询，不能只查一次。
 */
const PROVIDER_WAIT_MS = 12_000

/** 轮询间隔。 */
const POLL_INTERVAL_MS = 150

interface ProbingModel {
  id?: unknown
  name?: unknown
  description?: unknown
  context?: { contextWindow?: unknown } | undefined
}

interface ProbingProvider {
  id?: unknown
  name?: unknown
}

/** 最小化的上下文视图：只声明本探针用到的能力。 */
interface ProbeContext {
  llm: {
    listProviders(): readonly ProbingProvider[]
    listModels(provider: string): Promise<readonly ProbingModel[]>
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`模型清单查询超过 ${timeoutMs}ms`)), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function normaliseModels(models: readonly ProbingModel[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = []
  for (const model of models) {
    if (typeof model?.id !== 'string' || model.id.length === 0) continue
    const entry: Record<string, unknown> = {
      id: model.id,
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
    }
    if (typeof model.description === 'string' && model.description.length > 0) {
      entry.description = model.description
    }
    const contextWindow = model.context?.contextWindow
    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
      entry.contextWindow = contextWindow
    }
    result.push(entry)
  }
  return result
}

/**
 * 收集清单并落盘。`apply` 结束时 DSH 会继续启动其它插件，所以这里显式退出，
 * 避免探针进程长驻。
 */
export async function apply(ctx: ProbeContext): Promise<void> {
  const outPath = process.env.AGENT_SERVICE_MODEL_PROBE_OUT
  if (outPath === undefined || outPath.length === 0) {
    process.stderr.write('[model-probe] 未设置 AGENT_SERVICE_MODEL_PROBE_OUT，跳过\n')
    return
  }

  const payload: Record<string, unknown> = { probedAt: Date.now(), providers: [] }
  try {
    // 等 provider 插件激活（最多 PROVIDER_WAIT_MS），而不是只查一次。
    let providers = ctx.llm.listProviders()
    const waitDeadline = Date.now() + PROVIDER_WAIT_MS
    while (providers.length === 0 && Date.now() < waitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
      providers = ctx.llm.listProviders()
    }
    payload.providerWaitMs = PROVIDER_WAIT_MS - Math.max(waitDeadline - Date.now(), 0)

    const collected: Array<Record<string, unknown>> = []
    for (const provider of providers) {
      if (typeof provider?.id !== 'string' || provider.id.length === 0) continue
      const entry: Record<string, unknown> = {
        id: provider.id,
        name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : provider.id,
        models: [],
      }
      // 模型目录可能仍在异步填充（官方 `/models` 列表）：重试几次再放弃。
      let lastError: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const models = await withTimeout(ctx.llm.listModels(provider.id), PER_PROVIDER_TIMEOUT_MS)
          entry.models = normaliseModels(models)
          lastError = undefined
          if ((entry.models as unknown[]).length > 0) break
        } catch (error) {
          lastError = error
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      if (lastError !== undefined) entry.error = messageOf(lastError)
      collected.push(entry)
    }
    payload.providers = collected
  } catch (error) {
    payload.error = messageOf(error)
  }

  try {
    writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch (error) {
    process.stderr.write(`[model-probe] 写入失败: ${messageOf(error)}\n`)
  }
  process.stderr.write('[model-probe] done\n')
  setTimeout(() => process.exit(0), 50).unref?.()
}
