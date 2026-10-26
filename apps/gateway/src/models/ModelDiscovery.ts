/**
 * 从 DSH 读取模型清单：起一个**短命的 DSH 子进程**，用探针插件向 `ctx.llm` 询问，
 * 读结果文件后杀掉进程。
 *
 * 为什么不解析 `--dump-config`：配置文件里只有 adapter 的 `models` 覆盖项，
 * 真正的目录（官方 `/models` 列表或 adapter 内建目录）只有运行时知道；
 * 解析配置会在换 Provider / 换 baseURL / 换版本时立刻失准。
 *
 * 为什么不常驻：探针进程只做一次枚举，用完即退，避免额外资源占用。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ProviderOption } from '@agent-studio/shared'
import type { AgentConfigSnapshot } from '@agent-studio/shared'
import type { GatewayConfig } from '../config.js'
import type { Logger } from '../logger.js'
import type { MaterializedSnapshot, SnapshotMaterializer } from '../runtime/SnapshotMaterializer.js'

/** 探针使用的固定快照 key（独立于任何对话配置）。 */
export const PROBE_CONFIG_KEY = '_model-probe'

/** 探针文件与结果文件名。 */
const PROBE_PATCH_FILE = 'model-probe.cordis.yml'
const PROBE_RESULT_FILE = 'model-probe.json'

export interface ModelDiscoveryDeps {
  config: GatewayConfig
  logger: Logger
  materializer: SnapshotMaterializer
  /** 探针插件绝对路径（默认取构建产物；测试可覆盖）。 */
  probePluginPath?: string
  /** 覆盖进程启动（测试注入，禁止单测真的 spawn DSH）。 */
  spawnFn?: typeof spawn
}

export interface DiscoveryResult {
  providers: ProviderOption[]
  probedAt: number
  stderrTail?: string
}

/** 探针输入：没有技能、没有 MCP、没有提示词——只关心 provider 注册表。 */
function probeSnapshot(): AgentConfigSnapshot {
  return {
    skills: [],
    mcpServers: [],
    provider: '',
    model: '',
    systemPrompt: '',
    configKey: PROBE_CONFIG_KEY,
    projectId: '_probe',
    createdAt: Date.now(),
    inheritedFromProject: false,
  }
}

/** 解析探针输出；形状不符的条目直接丢弃并记日志（不因一个坏 provider 丢整张表）。 */
export function parseProbeOutput(raw: unknown, logger?: Logger): ProviderOption[] {
  if (raw === null || typeof raw !== 'object') throw new Error('探针输出不是对象')
  const providersRaw = (raw as { providers?: unknown }).providers
  if (!Array.isArray(providersRaw)) throw new Error('探针输出缺少 providers 数组')
  const providers: ProviderOption[] = []
  for (const item of providersRaw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    const models: ProviderOption['models'] = []
    const modelsRaw = record.models
    if (Array.isArray(modelsRaw)) {
      for (const model of modelsRaw) {
        if (model === null || typeof model !== 'object') continue
        const modelRecord = model as Record<string, unknown>
        if (typeof modelRecord.id !== 'string' || modelRecord.id.length === 0) continue
        const option: ProviderOption['models'][number] = {
          id: modelRecord.id,
          name:
            typeof modelRecord.name === 'string' && modelRecord.name.length > 0
              ? modelRecord.name
              : modelRecord.id,
        }
        if (typeof modelRecord.description === 'string' && modelRecord.description.length > 0) {
          option.description = modelRecord.description
        }
        if (
          typeof modelRecord.contextWindow === 'number' &&
          Number.isFinite(modelRecord.contextWindow) &&
          modelRecord.contextWindow > 0
        ) {
          option.contextWindow = modelRecord.contextWindow
        }
        models.push(option)
      }
    } else {
      logger?.warn('probe output: provider without models array', { provider: record.id })
    }
    const provider: ProviderOption = {
      id: record.id,
      name: typeof record.name === 'string' && record.name.length > 0 ? record.name : record.id,
      models,
    }
    if (typeof record.error === 'string' && record.error.length > 0) provider.error = record.error
    providers.push(provider)
  }
  return providers
}

/** 等待结果文件出现（探针写完即退出；stdout 不可靠，所以用文件）。 */
async function waitForFile(
  filePath: string,
  options: { timeoutMs: number; isDone?: () => boolean },
): Promise<boolean> {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      // 文件可能正在写入：要求能解析出 JSON 再返回。
      try {
        JSON.parse(fs.readFileSync(filePath, 'utf8'))
        return true
      } catch {
        /* 继续等 */
      }
    }
    if (options.isDone?.() === true) {
      // 进程已退出：再给文件一次机会（可能刚好写完）。
      return fs.existsSync(filePath)
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return false
}

export class ModelDiscovery {
  constructor(private readonly deps: ModelDiscoveryDeps) {}

  private get probePluginPath(): string {
    return (
      this.deps.probePluginPath ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'model-probe-plugin.js')
    )
  }

  /**
   * 执行一次发现。
   * @param options - 超时与日志
   * @returns provider 列表；探针失败时抛错（由上层降级到缓存）
   */
  async discover(options: { timeoutMs?: number } = {}): Promise<DiscoveryResult> {
    const logger = this.deps.logger.child({ component: 'model-discovery' })
    const timeoutMs = options.timeoutMs ?? 30_000

    const snapshot = probeSnapshot()
    const materialized: MaterializedSnapshot = this.deps.materializer.materialize(snapshot)
    const resultPath = path.join(materialized.rootDir, PROBE_RESULT_FILE)
    const patchPath = path.join(materialized.patchDir, PROBE_PATCH_FILE)

    const pluginPath = this.probePluginPath
    if (!fs.existsSync(pluginPath)) {
      throw new Error(`模型探针插件不存在: ${pluginPath}（先构建 gateway）`)
    }

    // 探针 patch：只插入探针插件，复用同一份 profile（provider 组合与对话运行时一致）
    fs.writeFileSync(
      patchPath,
      `# 模型清单探针（临时）：只读 ctx.llm，不激活任何业务能力\n- insert:\n    - id: agent-service-model-probe\n      name: ${JSON.stringify(pluginPath.replace(/\\/g, '/'))}\n`,
      'utf8',
    )
    fs.rmSync(resultPath, { force: true })

    const env: NodeJS.ProcessEnv = {
      ...materialized.env,
      AGENT_SERVICE_MODEL_PROBE_OUT: resultPath,
    }

    const spawnFn = this.deps.spawnFn ?? spawn
    const child = spawnFn(
      process.execPath,
      [
        this.deps.config.dshBin,
        '--profile',
        materialized.profileName,
        '--patch',
        patchPath,
      ],
      {
        cwd: materialized.workspaceDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-4000)
    })
    child.stdout?.on('data', () => {
      /* 探针不使用 stdout */
    })

    let exited = false
    const exitPromise = new Promise<void>((resolve) => {
      child.once('exit', () => {
        exited = true
        resolve()
      })
      child.once('error', () => {
        exited = true
        resolve()
      })
    })

    logger.debug('model probe started', { pluginPath, timeoutMs })
    const produced = await waitForFile(resultPath, { timeoutMs, isDone: () => exited })

    // 无论成功失败都不留进程。
    if (!exited) child.kill()
    await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 3_000))])

    if (!produced) {
      throw new Error(
        `模型探针在 ${timeoutMs}ms 内没有产出结果${stderrTail.length > 0 ? `；stderr: ${stderrTail.slice(-800)}` : ''}`,
      )
    }

    const raw = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as Record<string, unknown>
    if (typeof raw.error === 'string' && raw.error.length > 0) {
      throw new Error(`探针报告错误: ${raw.error}`)
    }
    const providers = parseProbeOutput(raw, logger)
    const probedAt = typeof raw.probedAt === 'number' ? raw.probedAt : Date.now()
    logger.info('model catalog discovered', {
      providers: providers.map((provider) => ({ id: provider.id, models: provider.models.length })),
    })
    return { providers, probedAt, stderrTail: stderrTail.slice(-800) }
  }
}
