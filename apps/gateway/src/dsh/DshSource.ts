/**
 * 复用**既有 DSH 配置**（review P0-1）。
 *
 * 目标：不要求用户在 Agent Service 里重新维护一套 Provider / Skills / MCP，
 * 也不把个人 `DSH_HOME` 直接共享给所有会话。
 *
 * 做法：只**读**源 profile，把"定义"导入到服务自己的运行时快照里：
 *
 * | 能力 | 读取方式 |
 * | --- | --- |
 * | Skills | 直接扫源 home 的技能目录（`<home>/skills`、`<home>/agents/skills`） |
 * | MCP / Provider 条目 | 把源 profile 的 manifest 复制成一个临时导入 profile，`dsh --dump-config` 组合出真实配置后解析 |
 * | 模型清单 | 运行时组合里已导入同一批 provider 插件，因此现有探针自然能列出它们 |
 *
 * 为什么复制而不是直接 dump：CLI 拒绝为 `desktop` 这类保留名做配置 dump（Desktop 持有它），
 * 复制成普通名字后既可 dump 也不影响源 profile。复制时用 junction 指向源 profile 的
 * `node_modules`，保证是"同一份插件"而不是再装一遍。
 *
 * 导入 profile 只用于**读取**组合；真正的运行时仍在我们自己的快照 home 里跑。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { McpServerDefinition } from '@agent-studio/shared'
import { mcpServerDefinitionSchema } from '@agent-studio/shared'
import type { Logger } from '../logger.js'

/** 一条可以插进我们 profile 的 patch 条目。 */
export interface ProviderPatchEntry {
  id: string
  name: string
  config?: Record<string, unknown>
}

export interface DshSourceOptions {
  /** 源 DSH home（例如 `C:\Users\me\.dsh`）；未设置 = 不启用。 */
  home: string | undefined
  /** 源 profile 名（例如 `desktop`、`sdk`）。 */
  profile: string
  /** dsh CLI 入口。 */
  dshBin: string
  /** 导入 profile 的落点（默认 `<runtimeDir>/dsh-import`）。 */
  workDir: string
  logger: Logger
  /** 是否导入 Provider 插件（默认 true；需要源 profile 的 node_modules）。 */
  importProviders: boolean
  /** 是否导入 MCP 服务器定义（默认 true）。 */
  importMcp: boolean
  now?: () => number
  cacheTtlMs?: number
  /** 测试注入：直接返回 dump 文本，不启动 dsh（生产为 undefined）。 */
  dumpOverride?: () => string
}

/** 组合里我们不导入的条目（与服务自己的 profile 冲突或本身就是宿主应用）。 */
const SKIPPED_ENTRY_IDS = new Set([
  'llm-deepseek',
  'llm-deepseek-api-key',
  'llm-deepseek-account',
  'llm',
  'session-title-llm',
  'llm-retry',
  'deepseek-llm-api-extensions',
])

/** 看起来像 provider 插件的名字特征。 */
const PROVIDER_NAME_HINT = /llm|provider|opencode|pi-ai/i

/** 不是 provider 的同名前缀条目（避免误导入会话标题等插件）。 */
const NON_PROVIDER_ID_PREFIX = /^(session-title|optional-session-title|deepseek-llm-api-extensions)/

/**
 * `!!js` 标签：保留原始表达式而不是求值。
 * 导入的 provider 条目里若带表达式，会以 `{ __jsExpr }` 形式保留，渲染回 patch 时还原成 `!!js`。
 */
const JS_EXPRESSION_TAG = {
  tag: 'tag:yaml.org,2002:js',
  resolve(value: unknown): JsExpression {
    return { __jsExpr: String(value) }
  },
}

/** 从 dump 里保留下来的 JS 表达式占位。 */
export interface JsExpression {
  __jsExpr: string
}

/** 源 DSH 的一处技能根。 */
export interface SourceSkillRoot {
  path: string
  label: string
}

export class DshSource {
  private dumpCache: { at: number; entries: ImportedEntry[]; error?: string } | undefined
  private readonly now: () => number

  constructor(private readonly options: DshSourceOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  get enabled(): boolean {
    return this.options.home !== undefined && this.options.home !== ''
  }

  /** 排障标识：`<home>#<profile>`。 */
  label(): string | undefined {
    return this.enabled ? `${this.options.home}#${this.options.profile}` : undefined
  }

  /* ---------------------------------------------------------------- Skills */

  /** 源 home 下的技能根（只返回存在的目录）。 */
  skillRoots(): SourceSkillRoot[] {
    if (!this.enabled) return []
    const home = this.options.home as string
    const candidates: SourceSkillRoot[] = [
      { path: path.join(home, 'skills'), label: `${home}#skills` },
      { path: path.join(home, 'agents', 'skills'), label: `${home}#agents/skills` },
    ]
    return candidates.filter((candidate) => fs.existsSync(candidate.path))
  }

  /* ------------------------------------------------------------ 组合导入 */

  /**
   * 组合源 profile（复制 manifest → junction node_modules → `--dump-config`）。
   * @returns 组合出的条目列表；失败时抛错（上层降级为空并记日志）
   */
  private dumpComposition(): ImportedEntry[] {
    const cached = this.dumpCache
    const ttl = this.options.cacheTtlMs ?? 60_000
    if (cached !== undefined && this.now() - cached.at < ttl) {
      if (cached.error !== undefined) throw new Error(cached.error)
      return cached.entries
    }

    try {
      const entries = this.doDump()
      this.dumpCache = { at: this.now(), entries }
      return entries
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.dumpCache = { at: this.now(), entries: [], error: message }
      throw error
    }
  }

  private doDump(): ImportedEntry[] {
    if (!this.enabled) return []
    // 测试注入：直接解析给定文本，不碰文件系统 / 不启动 dsh。
    if (this.options.dumpOverride !== undefined) {
      const injected = YAML.parse(this.options.dumpOverride(), {
        customTags: [JS_EXPRESSION_TAG],
        logLevel: 'silent',
      })
      if (!Array.isArray(injected)) throw new Error('注入的 dump 不是数组')
      return injected.filter((entry): entry is ImportedEntry => entry !== null && typeof entry === 'object')
    }
    const home = this.options.home as string
    const sourceProfileDir = path.join(home, 'profiles', this.options.profile)
    if (!fs.existsSync(path.join(sourceProfileDir, 'package.json'))) {
      throw new Error(`源 DSH profile 不存在: ${sourceProfileDir}`)
    }

    const hash = createHash('sha256').update(`${home}#${this.options.profile}`).digest('hex').slice(0, 8)
    const importName = `import-${hash}`
    const root = path.join(this.options.workDir, hash)
    const importHome = path.join(root, 'home')
    const profileDir = path.join(importHome, 'profiles', importName)
    fs.mkdirSync(profileDir, { recursive: true })

    for (const file of ['package.json', 'cordis.patch.yml', 'cordis.yml']) {
      const source = path.join(sourceProfileDir, file)
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(profileDir, file))
    }
    // 名字改成导入名（保留源组件不变），避免与保留名/宿主的 profile 冲突。
    const manifestPath = path.join(profileDir, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.name = `dsh-profile-${importName}`
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    const sourceNodeModules = path.join(sourceProfileDir, 'node_modules')
    const targetNodeModules = path.join(profileDir, 'node_modules')
    if (fs.existsSync(sourceNodeModules) && !fs.existsSync(targetNodeModules)) {
      try {
        fs.symlinkSync(sourceNodeModules, targetNodeModules, 'junction')
      } catch (error) {
        this.options.logger.warn('dsh-source: linking node_modules failed; bundles may not resolve', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }


    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      TEMP: path.join(importHome, 'tmp'),
      TMP: path.join(importHome, 'tmp'),
      HOME: importHome,
      USERPROFILE: importHome,
      DSH_HOME: importHome,
      DSH_TELEMETRY_DISABLED: '1',
    }
    fs.mkdirSync(path.join(importHome, 'tmp'), { recursive: true })

    const result = spawnSync(process.execPath, [this.options.dshBin, '--profile', importName, '--dump-config'], {
      cwd: importHome,
      env,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    })
    if (result.status !== 0) {
      throw new Error(
        `dsh --dump-config 失败（exit ${String(result.status)}）：${(result.stderr ?? '').slice(-800)}`,
      )
    }
    const parsed = YAML.parse(result.stdout ?? '', {
      customTags: [JS_EXPRESSION_TAG],
      logLevel: 'silent',
    })
    if (!Array.isArray(parsed)) throw new Error('dump-config 输出不是数组')
    this.options.logger.info('dsh-source: composition imported', {
      label: this.label(),
      entries: parsed.length,
      importProfile: importName,
    })
    return parsed.filter((entry): entry is ImportedEntry => entry !== null && typeof entry === 'object')
  }

  /* --------------------------------------------------------------- MCP */

  /** 从源组合里导入 MCP 服务器定义（`${ENV}` 引用会被还原成占位符）。 */
  mcpDefinitions(): McpServerDefinition[] {
    if (!this.enabled || !this.options.importMcp) return []
    let entries: ImportedEntry[]
    try {
      entries = this.dumpComposition()
    } catch (error) {
      this.options.logger.warn('dsh-source: MCP import skipped (composition unavailable)', {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    const servers: McpServerDefinition[] = []
    for (const entry of entries) {
      if (entry.name !== '@deepseek-ai/dsh-mcp-client') continue
      const config = asRecord(entry.config)
      if (config === undefined) continue
      const id = normaliseServerId(
        typeof config.serverName === 'string' ? config.serverName : String(entry.id ?? '').replace(/^mcp-client-/, ''),
      )
      if (id === '') continue
      const candidate = {
        id,
        name: id,
        description: `从 DSH Profile 导入（${this.label() ?? ''}）`,
        transport: config.transport === 'streamable-http' ? 'streamable-http' : 'stdio',
        ...(typeof config.command === 'string' ? { command: config.command } : {}),
        args: Array.isArray(config.args) ? config.args.filter((item): item is string => typeof item === 'string') : [],
        env: expressionMap(config.env),
        ...(typeof config.url === 'string' ? { url: config.url } : {}),
        headers: expressionMap(config.headers),
        toolCallTimeoutMs:
          typeof config.toolCallTimeoutMs === 'number' ? config.toolCallTimeoutMs : 30_000,
        failOnStartup: config.failOnStartupError === true,
        enabled: true,
      }
      const parsed = mcpServerDefinitionSchema.safeParse(candidate)
      if (parsed.success) servers.push(parsed.data)
      else {
        this.options.logger.warn('dsh-source: skipping invalid imported MCP server', {
          server: id,
          issues: parsed.error.issues.map((issue) => issue.message),
        })
      }
    }
    return servers
  }

  /* ----------------------------------------------------------- Provider */

  /**
   * 从源组合里挑选 Provider 类插件条目（跳过与服务自身冲突的 id）。
   * 这些条目会被插入到每个运行时快照的 profile patch 里。
   */
  providerEntries(): ProviderPatchEntry[] {
    if (!this.enabled || !this.options.importProviders) return []
    let entries: ImportedEntry[]
    try {
      entries = this.dumpComposition()
    } catch (error) {
      this.options.logger.warn('dsh-source: provider import skipped (composition unavailable)', {
        error: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    const result: ProviderPatchEntry[] = []
    for (const entry of entries) {
      const id = typeof entry.id === 'string' ? entry.id : undefined
      const name = typeof entry.name === 'string' ? entry.name : undefined
      if (id === undefined || name === undefined) continue
      if (SKIPPED_ENTRY_IDS.has(id)) continue
      if (NON_PROVIDER_ID_PREFIX.test(id)) continue
      if (!PROVIDER_NAME_HINT.test(name)) continue
      if (entry.disabled === true) continue
      const config = asRecord(entry.config)
      result.push({
        id,
        name,
        ...(config === undefined ? {} : { config }),
      })
    }
    return result
  }

  /** 源 profile 的 node_modules（provider 插件从这里解析）。 */
  sourceNodeModulesDir(): string | undefined {
    if (!this.enabled) return undefined
    const dir = path.join(this.options.home as string, 'profiles', this.options.profile, 'node_modules')
    return fs.existsSync(dir) ? dir : undefined
  }

  /** 源 DSH 的托管凭据文件路径。 */
  credentialsPath(): string {
    return path.join(this.options.home as string, '.credentials.yaml')
  }

  /** 导入的 provider 声明了哪些凭据变量，以及它们是否可解析（只报来源，不报值）。 */
  credentialStatus(entries?: readonly ProviderPatchEntry[]): CredentialStatus[] {
    if (!this.enabled) return []
    const list = entries ?? this.providerEntries()
    const names = providerCredentialNames(list)
    const fromFile = new Set(readCredentialRefNames(this.credentialsPath()))
    return names.map((name) => {
      const value = process.env[name]
      if (value !== undefined && value !== '') return { name, availableIn: 'env' as const }
      if (fromFile.has(name)) return { name, availableIn: 'dsh-credentials' as const }
      return { name, availableIn: 'missing' as const }
    })
  }

  /**
   * 为运行时准备的 provider 凭据值（环境变量优先，其次源 DSH 的托管凭据文件）。
   * 只返回**可解析**的变量；缺失项由调用方记录警告（不阻断启动）。
   */
  providerEnvValues(names?: readonly string[]): Record<string, string> {
    if (!this.enabled) return {}
    const wanted = names ?? providerCredentialNames(this.providerEntries())
    const fromFile = readCredentialValues(this.credentialsPath())
    const values: Record<string, string> = {}
    for (const name of wanted) {
      const fromEnv = process.env[name]
      if (fromEnv !== undefined && fromEnv !== '') {
        values[name] = fromEnv
        continue
      }
      const fromCredentials = fromFile[name]
      if (fromCredentials !== undefined) values[name] = fromCredentials
    }
    return values
  }

  /** 缺哪些 provider 凭据（排障用；只报名字）。 */
  missingProviderCredentials(): string[] {
    return this.credentialStatus()
      .filter((status) => status.availableIn === 'missing')
      .map((status) => status.name)
  }

  /** 诊断信息（`GET /api/dsh-source`）。 */
  describe(): {
    enabled: boolean
    label?: string
    profile?: string
    importProviders: boolean
    importMcp: boolean
    skillRoots: string[]
    providers: ProviderPatchEntry[]
    mcpServers: string[]
    /** provider 依赖的凭据变量及其可解析来源（只报名字）。 */
    credentials: CredentialStatus[]
    /** 源 profile 的 node_modules（provider 插件解析处）。 */
    nodeModules?: string
    error?: string
  } {
    if (!this.enabled) {
      return {
        enabled: false,
        importProviders: this.options.importProviders,
        importMcp: this.options.importMcp,
        skillRoots: [],
        providers: [],
        mcpServers: [],
        credentials: [],
      }
    }
    const skillRoots = this.skillRoots().map((root) => root.path)
    try {
      const providers = this.providerEntries()
      const mcpServers = this.mcpDefinitions().map((server) => server.id)
      const nodeModules = this.sourceNodeModulesDir()
      return {
        enabled: true,
        label: this.label(),
        profile: this.options.profile,
        importProviders: this.options.importProviders,
        importMcp: this.options.importMcp,
        skillRoots,
        providers,
        mcpServers,
        credentials: this.credentialStatus(providers),
        ...(nodeModules === undefined ? {} : { nodeModules }),
      }
    } catch (error) {
      return {
        enabled: true,
        label: this.label(),
        profile: this.options.profile,
        importProviders: this.options.importProviders,
        importMcp: this.options.importMcp,
        skillRoots,
        providers: [],
        mcpServers: [],
        credentials: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}

/* ------------------------------------------------------------------ 工具 */

interface ImportedEntry {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
  [key: string]: unknown
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** MCP id 只允许字母数字下划线与连字符。 */
export function normaliseServerId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
}

/**
 * 把 dump 里常见的 `!!js` 表达式还原成 `${ENV}` 引用。
 * 支持：`process.env.X`、`process.env.X ?? ''`、`Bearer ${process.env.X}`。
 * 其它表达式无法安全还原 → 丢弃该键（宁可缺少，也不把表达式当字面量写死）。
 */
export function expressionMap(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (record === undefined) return {}
  const result: Record<string, string> = {}
  for (const [key, raw] of Object.entries(record)) {
    const restored = restoreExpression(raw)
    if (restored !== undefined) result[key] = restored
  }
  return result
}

function restoreExpression(raw: unknown): string | undefined {
  // 从 dump 里解析出来的 `!!js` 会保留成 { __jsExpr }，先取出表达式文本。
  const expression =
    raw !== null && typeof raw === 'object' && typeof (raw as { __jsExpr?: unknown }).__jsExpr === 'string'
      ? (raw as { __jsExpr: string }).__jsExpr
      : raw
  if (typeof expression !== 'string') return undefined
  const trimmed = expression.trim()
  // 纯引用：process.env.NAME 或 process.env.NAME ?? ''
  const direct = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)(?:\s*\?\?\s*(?:''|""|null|undefined))?$/.exec(trimmed)
  if (direct !== null) return `\${${direct[1]}}`
  // 模板：`Bearer ${process.env.NAME ?? ''}`
  if (trimmed.includes('process.env.')) {
    return trimmed
      .replace(/^`|`$/g, '')
      .replace(/\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g, (_match, name: string) => `\${${name}}`)
  }
  // 普通字面量
  return trimmed
}

/* ------------------------------------------------------- 依赖与凭据清单 */

/** 环境变量名的形状（用于识别 provider 条目里声明的凭据引用）。 */
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,}$/

/** provider 条目里声明的凭据环境变量名（`apiKeyEnv` 或任何 `*Env` 键）。 */
export function providerCredentialNames(entries: readonly ProviderPatchEntry[]): string[] {
  const names = new Set<string>()
  const visit = (value: unknown, key: string | undefined): void => {
    if (typeof value === 'string') {
      if (key !== undefined && /(apiKeyEnv|credentialRef|Env)$/i.test(key) && ENV_NAME.test(value.trim())) {
        names.add(value.trim())
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, undefined)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) visit(child, childKey)
    }
  }
  for (const entry of entries) visit(entry.config, undefined)
  return [...names]
}

/** 源 DSH 的托管凭据文件（`refs.<NAME>`）里的键名。只读键，不返回值。 */
export function readCredentialRefNames(credentialsPath: string): string[] {
  try {
    const parsed = YAML.parse(fs.readFileSync(credentialsPath, 'utf8'), { logLevel: 'silent' }) as unknown
    if (parsed === null || typeof parsed !== 'object') return []
    const refs = (parsed as { refs?: unknown }).refs
    if (refs === null || typeof refs !== 'object') return []
    return Object.keys(refs as Record<string, unknown>)
  } catch {
    return []
  }
}

/** 从托管凭据文件里取具体值（只取字符串；结构化的记录跳过）。 */
export function readCredentialValues(credentialsPath: string): Record<string, string> {
  const values: Record<string, string> = {}
  try {
    const parsed = YAML.parse(fs.readFileSync(credentialsPath, 'utf8'), { logLevel: 'silent' }) as unknown
    if (parsed === null || typeof parsed !== 'object') return values
    const refs = (parsed as { refs?: unknown }).refs
    if (refs === null || typeof refs !== 'object') return values
    for (const [name, value] of Object.entries(refs as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) values[name] = value
    }
  } catch {
    /* 读不到就是没有 */
  }
  return values
}

/** 凭据可用性（只报来源，不报值）。 */
export interface CredentialStatus {
  name: string
  availableIn: 'env' | 'dsh-credentials' | 'missing'
}