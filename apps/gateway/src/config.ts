/**
 * 网关配置：只从环境变量读取，启动时解析一次。
 *
 * 安全要求（docs/DECISIONS.md §9）：
 * - 子进程环境变量必须从零构造，因此这里只收集"允许注入"的最小字段；
 * - 不读取、不转发开发者个人的 `DSH_HOME`；
 * - Provider 凭据只来自网关自己的配置。
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LogLevel } from './logger.js'

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url))

/** 仓库根目录：源码运行（src/）与编译运行（dist/）都是上三级。 */
export const REPO_ROOT = path.resolve(SOURCE_DIR, '..', '..', '..')

export interface ProviderEnvConfig {
  /** 默认 provider id（Agent 配置可覆盖，但必须与运行时注册的一致）。 */
  provider: string
  /** 默认模型 id。 */
  model: string
  /** provider 凭据；只注入运行时子进程。 */
  apiKey?: string
  /** 自建/代理端点。 */
  baseUrl?: string
  /** mock-LLM 模式下追加给子进程的额外环境变量。 */
  extraEnv: Record<string, string>
}

export interface GatewayConfig {
  host: string
  port: number
  dataDir: string
  runtimeDir: string
  dshBin: string
  dshProfile: string
  pluginPolicy: string
  pluginTools: string
  pluginAudit: string
  authSecret: string
  tokenTtlHours: number
  runtimeIdleMs: number
  approvalTimeoutMs: number
  dshPermissionMode: string
  mockLlm: string | undefined
  webDist: string | undefined
  logLevel: LogLevel
  dshVersion: string
  provider: ProviderEnvConfig
}

const DEFAULT_DSH_VERSION = '0.2.1-rc.3'

function envString(env: NodeJS.ProcessEnv, name: string, fallback: string | undefined): string | undefined {
  const value = env[name]
  if (value === undefined || value.trim() === '') return fallback
  return value
}

function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envString(env, name, undefined)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

/** 读取可用于日志/健康检查的 DSH 运行时版本。 */
function readDshVersion(repoRoot: string): string {
  try {
    const manifestPath = path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : DEFAULT_DSH_VERSION
  } catch {
    return DEFAULT_DSH_VERSION
  }
}

/** 读取或生成令牌签名密钥（落盘在 DATA_DIR/.auth-secret，权限 0600）。 */
function resolveAuthSecret(env: NodeJS.ProcessEnv, dataDir: string): string {
  const fromEnv = envString(env, 'AUTH_SECRET', undefined)
  if (fromEnv !== undefined) return fromEnv

  const secretPath = path.join(dataDir, '.auth-secret')
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim()
    if (existing.length >= 32) return existing
  } catch {
    // 文件不存在：生成一个。
  }

  const generated = randomBytes(48).toString('base64url')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(secretPath, `${generated}\n`, { mode: 0o600 })
  return generated
}

/**
 * 解析配置。`repoRoot` 只在测试里覆盖。
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot: string = REPO_ROOT,
): GatewayConfig {
  const dataDir = path.resolve(envString(env, 'DATA_DIR', path.join(repoRoot, 'data')) as string)
  const runtimeDir = path.resolve(envString(env, 'RUNTIME_DIR', path.join(repoRoot, 'runtime')) as string)
  const logLevel = (envString(env, 'LOG_LEVEL', 'info') as LogLevel | undefined) ?? 'info'

  const extraEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === '') continue
    if (key.startsWith('AGENT_STUDIO_PROVIDER_ENV_')) {
      extraEnv[key.slice('AGENT_STUDIO_PROVIDER_ENV_'.length)] = value
    }
  }

  const apiKey = envString(env, 'DEEPSEEK_API_KEY', undefined)
  if (apiKey !== undefined) extraEnv.DEEPSEEK_API_KEY = apiKey
  const baseUrl = envString(env, 'DEEPSEEK_BASE_URL', undefined)
  if (baseUrl !== undefined) extraEnv.DEEPSEEK_BASE_URL = baseUrl

  return {
    host: envString(env, 'HOST', '127.0.0.1') as string,
    port: envNumber(env, 'PORT', 8787),
    dataDir,
    runtimeDir,
    dshBin: path.resolve(
      envString(env, 'DSH_BIN', path.join(repoRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) as string,
    ),
    // 只认 Agent Studio 自己的变量：宿主环境（例如 DSH Desktop）常把 DSH_PROFILE
    // 设成 "desktop"，若直接沿用会让网关去启动 desktop profile 并因保留名被拒绝。
    dshProfile: envString(env, 'AGENT_STUDIO_DSH_PROFILE', 'studio') as string,
    pluginPolicy: path.resolve(
      envString(
        env,
        'AGENT_STUDIO_PLUGIN_POLICY',
        path.join(repoRoot, 'plugins', 'agent-policy', 'dist', 'index.js'),
      ) as string,
    ),
    pluginTools: path.resolve(
      envString(
        env,
        'AGENT_STUDIO_PLUGIN_TOOLS',
        path.join(repoRoot, 'plugins', 'agent-tools', 'dist', 'index.js'),
      ) as string,
    ),
    pluginAudit: path.resolve(
      envString(
        env,
        'AGENT_STUDIO_PLUGIN_AUDIT',
        path.join(repoRoot, 'plugins', 'agent-audit', 'dist', 'index.js'),
      ) as string,
    ),
    authSecret: resolveAuthSecret(env, dataDir),
    tokenTtlHours: envNumber(env, 'TOKEN_TTL_HOURS', 12),
    runtimeIdleMs: envNumber(env, 'RUNTIME_IDLE_MS', 600_000),
    approvalTimeoutMs: envNumber(env, 'APPROVAL_TIMEOUT_MS', 120_000),
    dshPermissionMode: envString(env, 'DSH_PERMISSION_MODE', 'workspace-write') as string,
    mockLlm: envString(env, 'MOCK_LLM', undefined),
    webDist: envString(env, 'WEB_DIST', path.join(repoRoot, 'apps', 'web', 'dist')),
    logLevel,
    dshVersion: readDshVersion(repoRoot),
    provider: {
      provider: envString(env, 'DSH_PROVIDER', 'deepseek-official') as string,
      model: envString(env, 'DSH_MODEL', 'deepseek-v4-flash') as string,
      apiKey,
      baseUrl,
      extraEnv,
    },
  }
}

/** 启动日志用的脱敏视图：绝不打印 secret / apiKey。 */
export function describeConfig(config: GatewayConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    runtimeDir: config.runtimeDir,
    dshBin: config.dshBin,
    dshProfile: config.dshProfile,
    dshVersion: config.dshVersion,
    plugins: {
      policy: config.pluginPolicy,
      tools: config.pluginTools,
      audit: config.pluginAudit,
    },
    authSecret: '[redacted]',
    tokenTtlHours: config.tokenTtlHours,
    runtimeIdleMs: config.runtimeIdleMs,
    approvalTimeoutMs: config.approvalTimeoutMs,
    dshPermissionMode: config.dshPermissionMode,
    mockLlm: config.mockLlm === undefined ? false : true,
    webDist: config.webDist,
    provider: {
      provider: config.provider.provider,
      model: config.provider.model,
      apiKey: config.provider.apiKey === undefined ? '[absent]' : '[redacted]',
      baseUrl: config.provider.baseUrl ?? '[default]',
      extraEnvKeys: Object.keys(config.provider.extraEnv),
    },
  }
}
