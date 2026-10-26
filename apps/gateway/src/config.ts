/**
 * 服务配置：只从环境变量读取，启动时解析一次（docs/SERVICE.md §3.1）。
 *
 * 两条硬约束：
 * - **不读宿主 `DSH_PROFILE`**：只认 `AGENT_SERVICE_DSH_PROFILE`（默认 `agent-service`）。
 *   DSH Desktop 等宿主常把 `DSH_PROFILE` 设成 `desktop`，沿用会让运行时起错 profile。
 * - 这里只收集"允许注入子进程"的最小字段；子进程环境由 `SnapshotMaterializer`
 *   从零构造，不继承宿主 `DSH_HOME` / 代理变量。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LogLevel } from './logger.js'

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录：源码运行（src/）与编译运行（dist/）都是上三级。 */
export const REPO_ROOT = path.resolve(SOURCE_DIR, '..', '..', '..')

/** Provider 凭据：只进子进程环境，不落盘、不打日志。 */
export interface ProviderConfig {
  apiKey?: string
  /** 自建端点 / mock LLM；设置后 DSH 不会去拉官方模型列表。 */
  baseUrl?: string
}

export interface GatewayConfig {
  host: string
  port: number
  dataDir: string
  runtimeDir: string
  /** 技能根目录（按优先级排序，靠前者用于发现与复制）。 */
  skillsDirs: string[]
  mcpConfigPath: string
  dshBin: string
  /** 受限 profile 名（目录名 = `--profile` 参数）。 */
  dshProfile: string
  /** 业务工具插件入口（绝对路径，写进模板的 `{{TOOLS_PLUGIN}}`）。 */
  pluginTools: string
  /** 业务工具数据源目录（复制进快照 workspace）。 */
  toolsDataDir: string
  /** profile 模板目录（`runtime/templates/agent-service`）。 */
  templateDir: string
  provider: ProviderConfig
  mockLlm: string | undefined
  /** 是否向 DSH 询问模型清单（`AGENT_SERVICE_MODEL_DISCOVERY=off` 时关闭）。 */
  modelDiscovery: boolean
  /** 既有 DSH home（`DSH_SOURCE_HOME`）：用于导入 Skills / MCP / Provider 定义。 */
  dshSourceHome: string | undefined
  /** 既有 DSH profile 名（`DSH_SOURCE_PROFILE`，默认 `desktop`）。 */
  dshSourceProfile: string
  /** 是否从源 profile 导入 provider 插件（`DSH_SOURCE_IMPORT_PROVIDERS`，默认 on）。 */
  dshSourceImportProviders: boolean
  /** 是否从源 profile 导入 MCP 定义（`DSH_SOURCE_IMPORT_MCP`，默认 on）。 */
  dshSourceImportMcp: boolean
  /** 导入组合的落点（`<RUNTIME_DIR>/dsh-import`）。 */
  dshSourceWorkDir: string
  /** 模型清单磁盘缓存（`<DATA_DIR>/models.json`）。 */
  modelsCachePath: string
  /** 探针插件入口（默认 gateway 构建产物；测试可覆盖）。 */
  modelProbePlugin: string
  runtimeIdleMs: number
  turnTimeoutMs: number
  maxRuntimes: number
  internalToken: string | undefined
  corsOrigins: string[]
  webDist: string | undefined
  logLevel: LogLevel
  dshVersion: string
}

const DEFAULT_DSH_VERSION = '0.2.1-rc.3'
/** `MOCK_LLM` 置位且未显式给 `DEEPSEEK_BASE_URL` 时使用的本地 mock 端点。 */
const MOCK_LLM_BASE_URL = 'http://127.0.0.1:8899/v1'

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string | undefined): string | undefined {
  const value = env[name]
  if (value === undefined || value.trim() === '') return fallback
  return value.trim()
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envString(env, name, undefined)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function splitList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** 读取安装树里的 DSH 版本（健康检查用；读不到就回落到已知版本）。 */
function readDshVersion(repoRoot: string): string {
  try {
    const manifestPath = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : DEFAULT_DSH_VERSION
  } catch {
    return DEFAULT_DSH_VERSION
  }
}

/**
 * 解析配置。`repoRoot` / `env` 只在测试里覆盖。
 *
 * Provider 凭据规则：
 * - `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` 是唯一来源；
 * - `MOCK_LLM` 非空 = 离线模式：未显式给端点时指向本地 mock（`npm run mock:llm`），
 *   并放一个占位 key，保证运行时能启动（mock server 默认不校验 key）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, repoRoot: string = REPO_ROOT): GatewayConfig {
  const dataDir = path.resolve(envString(env, 'DATA_DIR', path.join(repoRoot, 'data')) as string)
  const runtimeDir = path.resolve(envString(env, 'RUNTIME_DIR', path.join(repoRoot, 'runtime')) as string)

  const skillsDirs = splitList(envString(env, 'SKILLS_DIRS', path.join(repoRoot, 'runtime', 'skills'))).map((entry) =>
    path.resolve(entry),
  )

  const mockLlm = envString(env, 'MOCK_LLM', undefined)
  const explicitBaseUrl = envString(env, 'DEEPSEEK_BASE_URL', undefined)
  const baseUrl = explicitBaseUrl ?? (mockLlm === undefined ? undefined : MOCK_LLM_BASE_URL)
  const apiKey = envString(env, 'DEEPSEEK_API_KEY', undefined) ?? (mockLlm === undefined ? undefined : 'mock-key')

  return {
    host: envString(env, 'HOST', '127.0.0.1') as string,
    port: envNumber(env, 'PORT', 8787),
    dataDir,
    runtimeDir,
    skillsDirs: skillsDirs.length > 0 ? skillsDirs : [path.join(repoRoot, 'runtime', 'skills')],
    mcpConfigPath: path.resolve(
      envString(env, 'MCP_CONFIG', path.join(repoRoot, 'config', 'mcp-servers.json')) as string,
    ),
    dshBin: path.resolve(
      envString(env, 'DSH_BIN', path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) as string,
    ),
    // 只认服务自己的变量：宿主的 DSH_PROFILE 一律忽略。
    dshProfile: envString(env, 'AGENT_SERVICE_DSH_PROFILE', 'agent-service') as string,
    pluginTools: path.resolve(
      envString(env, 'AGENT_SERVICE_PLUGIN_TOOLS', path.join(repoRoot, 'plugins', 'agent-tools', 'dist', 'index.js')) as string,
    ),
    toolsDataDir: path.resolve(
      envString(env, 'AGENT_SERVICE_TOOLS_DATA_DIR', path.join(repoRoot, 'runtime', 'tools')) as string,
    ),
    templateDir: path.join(repoRoot, 'runtime', 'templates', 'agent-service'),
    provider: {
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(baseUrl === undefined ? {} : { baseUrl }),
    },
    mockLlm,
    modelDiscovery: (envString(env, 'AGENT_SERVICE_MODEL_DISCOVERY', 'on') as string).toLowerCase() !== 'off',
    modelsCachePath: path.join(dataDir, 'models.json'),
    dshSourceHome: envString(env, 'DSH_SOURCE_HOME', undefined),
    dshSourceProfile: envString(env, 'DSH_SOURCE_PROFILE', 'desktop') as string,
    dshSourceImportProviders: (envString(env, 'DSH_SOURCE_IMPORT_PROVIDERS', 'on') as string).toLowerCase() !== 'off',
    dshSourceImportMcp: (envString(env, 'DSH_SOURCE_IMPORT_MCP', 'on') as string).toLowerCase() !== 'off',
    dshSourceWorkDir: path.join(runtimeDir, 'dsh-import'),
    modelProbePlugin: path.resolve(
      envString(
        env,
        'AGENT_SERVICE_MODEL_PROBE',
        path.join(SOURCE_DIR, 'runtime', 'model-probe-plugin.js'),
      ) as string,
    ),
    runtimeIdleMs: envNumber(env, 'RUNTIME_IDLE_MS', 300_000),
    turnTimeoutMs: envNumber(env, 'TURN_TIMEOUT_MS', 600_000),
    maxRuntimes: envNumber(env, 'MAX_RUNTIMES', 8),
    internalToken: envString(env, 'INTERNAL_TOKEN', undefined),
    corsOrigins: splitList(envString(env, 'CORS_ORIGINS', undefined)),
    webDist: envString(env, 'WEB_DIST', path.join(repoRoot, 'apps', 'web', 'dist')),
    logLevel: (envString(env, 'LOG_LEVEL', 'info') as LogLevel | undefined) ?? 'info',
    dshVersion: readDshVersion(repoRoot),
  }
}

/** 启动日志用的脱敏视图：绝不打印 token / apiKey。 */
export function describeConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    runtimeDir: config.runtimeDir,
    skillsDirs: config.skillsDirs,
    mcpConfigPath: config.mcpConfigPath,
    dshBin: config.dshBin,
    dshProfile: config.dshProfile,
    dshVersion: config.dshVersion,
    pluginTools: config.pluginTools,
    toolsDataDir: config.toolsDataDir,
    templateDir: config.templateDir,
    runtimeIdleMs: config.runtimeIdleMs,
    turnTimeoutMs: config.turnTimeoutMs,
    maxRuntimes: config.maxRuntimes,
    internalToken: config.internalToken === undefined ? '[absent]' : '[redacted]',
    corsOrigins: config.corsOrigins,
    mockLlm: config.mockLlm !== undefined,
    modelDiscovery: config.modelDiscovery,
    modelsCachePath: config.modelsCachePath,
    dshSourceHome: config.dshSourceHome ?? '[disabled]',
    dshSourceProfile: config.dshSourceImportProviders || config.dshSourceImportMcp ? config.dshSourceProfile : '[unused]',
    dshSourceImportProviders: config.dshSourceImportProviders,
    dshSourceImportMcp: config.dshSourceImportMcp,
    provider: {
      apiKey: config.provider.apiKey === undefined ? '[absent]' : '[redacted]',
      baseUrl: config.provider.baseUrl ?? '[default]',
    },
  }
}
