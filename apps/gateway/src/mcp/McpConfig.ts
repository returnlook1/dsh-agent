/**
 * MCP 服务器定义的读取、校验与"凭据引用"处理（docs/SERVICE.md §3.2）。
 *
 * ## 凭据安全（review 修复点）
 *
 * 配置里写的是**引用**：`${GIS_SERVICE_TOKEN}`。旧实现会先把它展开成真实值，再把
 * 展开后的对象序列化进 `mcp.cordis.yml` —— 密钥因此以明文落盘。
 *
 * 现在：
 * - `command` / `args` / `url` 只展开 `${REPO_ROOT}`；出现 `${ENV}` 直接报错
 *   （强制把凭据放在 `env` / `headers`，不要放在命令行参数里）；
 * - `env` / `headers` 的值保留为**表达式**（`{ kind: 'env' }` / `{ kind: 'template' }`），
 *   由渲染层输出成 `!!js process.env.X`，在 DSH 子进程启动时求值；
 * - 只把被引用的环境变量按白名单注入子进程；缺失即报错（fail closed）；
 * - 日志与接口只出现变量名，不出现值。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { McpServerDefinition, McpServerSource, McpServerSummaryDto } from '@agent-studio/shared'
import { mcpServerDefinitionSchema } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import { ApiError, validationError } from '../http/errors.js'

const fileSchema = z.object({
  servers: z.array(mcpServerDefinitionSchema).default([]),
})

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** 一个值在运行时的求值方式。 */
export type McpValueExpr =
  | { kind: 'literal'; value: string }
  | { kind: 'env'; name: string }
  | { kind: 'template'; template: string; names: string[] }

/** 渲染运行时 patch 用的 MCP 条目（不含任何真实凭据）。 */
export interface RuntimeMcpServer {
  id: string
  transport: McpServerDefinition['transport']
  serverName: string
  command?: string
  args: string[]
  url?: string
  toolCallTimeoutMs: number
  failOnStartup: boolean
  env: Record<string, McpValueExpr>
  headers: Record<string, McpValueExpr>
  /** 需要注入子进程的环境变量名（去重）。 */
  envNames: string[]
}

/** 从 `${...}` 引用构造表达式；纯字面量原样保留。 */
export function parseValueExpression(value: string): McpValueExpr {
  const names = [...value.matchAll(PLACEHOLDER)].map((match) => match[1] as string)
  if (names.length === 0) return { kind: 'literal', value }
  // 整个值就是一个引用 → 直接取环境变量（最常见的写法）
  if (value.trim() === `\${${names[0]}}`) return { kind: 'env', name: names[0] as string }
  return { kind: 'template', template: value, names: [...new Set(names)] }
}

/**
 * 只展开 `${REPO_ROOT}`；剩余任何 `${ENV}` 都视为配置错误。
 * @throws Error 当值里仍引用了环境变量
 */
export function resolvePathPlaceholders(value: string, repoRoot: string, what: string): string {
  const resolved = value.replace(PLACEHOLDER, (match, name: string) => {
    if (name === 'REPO_ROOT') return repoRoot.replaceAll('\\', '/')
    throw new Error(`${what} 引用了 ${match}：凭据请放在 env / headers，不要放在 command/args/url`)
  })
  return resolved
}

export class McpConfig {
  private definitionsCache: { mtimeMs: number; size: number; servers: McpServerDefinition[] } | undefined
  private extraCache: { at: number; servers: McpServerDefinition[] } | undefined

  constructor(
    private readonly options: {
      configPath: string
      logger: Logger
      /** 服务进程环境（测试可注入）。 */
      env?: NodeJS.ProcessEnv
      /** `${REPO_ROOT}` 的值（默认取仓库根目录）。 */
      repoRoot: string
      /**
       * 额外定义（例如从既有 DSH Profile 导入的 MCP）。同名时本地配置文件优先。
       * 返回 `{ servers, source }` 便于 UI 标注来源。
       */
      extraDefinitions?: () => { servers: McpServerDefinition[]; source: McpServerSource; label?: string }
      /** 额外定义的缓存时间（默认 60s：导入要跑一次 dsh）。 */
      extraTtlMs?: number
    },
  ) {}

  get configPath(): string {
    return this.options.configPath
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  /* ------------------------------------------------------------ 定义合并 */

  /** 本地配置文件里的定义（文件缺失 = 空清单，不是错误）。 */
  private localDefinitions(): McpServerDefinition[] {
    if (!fs.existsSync(this.options.configPath)) {
      this.options.logger.warn('mcp: config file not found; no local servers', {
        configPath: this.options.configPath,
      })
      return []
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(this.options.configPath)
    } catch {
      return []
    }
    if (
      this.definitionsCache !== undefined &&
      this.definitionsCache.mtimeMs === stat.mtimeMs &&
      this.definitionsCache.size === stat.size
    ) {
      return this.definitionsCache.servers
    }

    let servers: McpServerDefinition[] = []
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.configPath, 'utf8')) as unknown
      const parsed = fileSchema.safeParse(raw)
      if (!parsed.success) {
        this.options.logger.error('mcp: config file is invalid', {
          configPath: this.options.configPath,
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        })
      } else {
        servers = parsed.data.servers
      }
    } catch (error) {
      this.options.logger.error('mcp: config file is unreadable', {
        configPath: this.options.configPath,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    this.definitionsCache = { mtimeMs: stat.mtimeMs, size: stat.size, servers }
    return servers
  }

  /** 从既有 DSH Profile 导入的定义（带缓存；失败降级为空并记日志）。 */
  private importedDefinitions(): McpServerDefinition[] {
    const loader = this.options.extraDefinitions
    if (loader === undefined) return []
    const ttl = this.options.extraTtlMs ?? 60_000
    const now = Date.now()
    if (this.extraCache !== undefined && now - this.extraCache.at < ttl) return this.extraCache.servers
    try {
      const { servers } = loader()
      this.extraCache = { at: now, servers }
      return servers
    } catch (error) {
      this.options.logger.warn('mcp: importing definitions from DSH profile failed', {
        error: error instanceof Error ? error.message : String(error),
      })
      this.extraCache = { at: now, servers: [] }
      return []
    }
  }

  /** 全部定义：本地文件优先，补充从 DSH Profile 导入的（按 id 去重）。 */
  definitions(): McpServerDefinition[] {
    const local = this.localDefinitions()
    const localIds = new Set(local.map((server) => server.id))
    const imported = this.importedDefinitions().filter((server) => !localIds.has(server.id))
    return [...local, ...imported]
  }

  /** 某个定义来自哪里（UI 标注用）。 */
  sourceOf(id: string): McpServerSource {
    return this.localDefinitions().some((server) => server.id === id) ? 'config' : 'dsh-profile'
  }

  /** GET /api/mcp-servers（全部条目，含 enabled 与来源）。 */
  summaries(): McpServerSummaryDto[] {
    const localIds = new Set(this.localDefinitions().map((server) => server.id))
    return this.definitions().map((server) => ({
      id: server.id,
      name: server.name,
      ...(server.description === undefined ? {} : { description: server.description }),
      transport: server.transport,
      enabled: server.enabled,
      source: localIds.has(server.id) ? 'config' : 'dsh-profile',
    }))
  }

  /** 来自 DSH Profile 的标识（未启用导入时为 undefined）。 */
  importLabel(): string | undefined {
    try {
      return this.options.extraDefinitions?.().label
    } catch {
      return undefined
    }
  }

  /** 可用于对话的服务器（enabled 且定义存在）。 */
  get(id: string): McpServerDefinition | undefined {
    return this.definitions().find((server) => server.id === id && server.enabled)
  }

  /** 校验一组服务器 id，全部可用才返回定义；否则抛 `MCP_UNKNOWN`（附带可用项）。 */
  assertKnown(ids: readonly string[]): McpServerDefinition[] {
    const found: McpServerDefinition[] = []
    const unknown: string[] = []
    for (const id of ids) {
      const definition = this.get(id)
      if (definition === undefined) unknown.push(id)
      else found.push(definition)
    }
    if (unknown.length > 0) {
      throw new ApiError('MCP_UNKNOWN', `未知或未启用的 MCP 服务器: ${unknown.join(', ')}`, {
        unknown,
        available: this.definitions()
          .filter((server) => server.enabled)
          .map((server) => server.id),
      })
    }
    return found
  }

  /* ------------------------------------------------------ 凭据引用与运行时 */

  /** 定义里引用的所有环境变量名（不含 REPO_ROOT）。 */
  referencedEnvNames(definition: McpServerDefinition): string[] {
    const names = new Set<string>()
    for (const value of Object.values(definition.env)) {
      for (const match of value.matchAll(PLACEHOLDER)) {
        if (match[1] !== 'REPO_ROOT') names.add(match[1] as string)
      }
    }
    for (const value of Object.values(definition.headers)) {
      for (const match of value.matchAll(PLACEHOLDER)) {
        if (match[1] !== 'REPO_ROOT') names.add(match[1] as string)
      }
    }
    return [...names]
  }

  /**
   * 为目标运行时准备"只含引用"的条目（不做凭据展开）。
   * @throws ApiError 配置非法（例如 args 里放凭据、缺 command/url）
   */
  resolveForRuntime(definition: McpServerDefinition): RuntimeMcpServer {
    const repoRoot = this.options.repoRoot.replaceAll('\\', '/')
    const what = `MCP 服务器 "${definition.id}"`

    let command: string | undefined
    let url: string | undefined
    try {
      command =
        definition.command === undefined
          ? undefined
          : resolvePathPlaceholders(definition.command, repoRoot, `${what} 的 command`)
      url = definition.url === undefined ? undefined : resolvePathPlaceholders(definition.url, repoRoot, `${what} 的 url`)
    } catch (error) {
      throw validationError(error instanceof Error ? error.message : String(error), { serverId: definition.id })
    }
    const args = definition.args.map((arg) => resolvePathPlaceholders(arg, repoRoot, `${what} 的 args`))

    if (definition.transport === 'stdio' && (command === undefined || command === '')) {
      throw validationError(`MCP 服务器 "${definition.id}" 使用 stdio 但缺少 command`, { serverId: definition.id })
    }
    if (definition.transport === 'streamable-http' && (url === undefined || url === '')) {
      throw validationError(`MCP 服务器 "${definition.id}" 使用 streamable-http 但缺少 url`, { serverId: definition.id })
    }

    const env: Record<string, McpValueExpr> = {}
    for (const [key, value] of Object.entries(definition.env)) env[key] = parseValueExpression(value)
    const headers: Record<string, McpValueExpr> = {}
    for (const [key, value] of Object.entries(definition.headers)) headers[key] = parseValueExpression(value)

    const envNames = this.referencedEnvNames(definition)
    // 变量缺失时尽早失败，而不是让 DSH 用空值连上去（fail closed）。
    const missing = envNames.filter((name) => {
      const value = this.env[name]
      return value === undefined || value === ''
    })
    if (missing.length > 0) {
      throw validationError(
        `MCP 服务器 "${definition.id}" 引用了未设置的环境变量: ${missing.join(', ')}`,
        { serverId: definition.id, missingEnv: missing },
      )
    }

    return {
      id: definition.id,
      transport: definition.transport,
      serverName: definition.id,
      ...(command === undefined ? {} : { command }),
      args,
      ...(url === undefined ? {} : { url }),
      toolCallTimeoutMs: definition.toolCallTimeoutMs,
      failOnStartup: definition.failOnStartup,
      env,
      headers,
      envNames,
    }
  }

  /**
   * 构造一次探测的目标（凭据只在这次探测中用，不落盘、不进响应）。
   * @param definition - 服务器定义
   * @param timeoutMs - 探测超时（与定义里的工具超时取较小值）
   */
  probeTarget(
    definition: McpServerDefinition,
    timeoutMs: number,
  ): {
    id: string
    transport: McpServerDefinition['transport']
    command?: string
    args: string[]
    url?: string
    env: Record<string, string>
    headers: Record<string, string>
    timeoutMs: number
  } {
    const runtime = this.resolveForRuntime(definition)
    const resolve = (expr: McpValueExpr): string => {
      if (expr.kind === 'literal') return expr.value
      if (expr.kind === 'env') return this.env[expr.name] ?? ''
      return expr.template.replace(PLACEHOLDER, (_match, name: string) => this.env[name] ?? '')
    }
    const env: Record<string, string> = {}
    for (const [key, expr] of Object.entries(runtime.env)) env[key] = resolve(expr)
    const headers: Record<string, string> = {}
    for (const [key, expr] of Object.entries(runtime.headers)) headers[key] = resolve(expr)
    return {
      id: runtime.id,
      transport: runtime.transport,
      ...(runtime.command === undefined ? {} : { command: runtime.command }),
      args: runtime.args,
      ...(runtime.url === undefined ? {} : { url: runtime.url }),
      env,
      headers,
      timeoutMs: Math.min(Math.max(definition.toolCallTimeoutMs, 1_000), Math.max(timeoutMs, 1_000)),
    }
  }

  /**
   * 探测/直连时需要的真实环境变量（**只给 MCP 子进程**用，绝不落盘、不打日志）。
   * @throws ApiError 缺变量
   */
  envFor(definition: McpServerDefinition): Record<string, string> {
    const values: Record<string, string> = {}
    const missing: string[] = []
    for (const name of this.referencedEnvNames(definition)) {
      const value = this.env[name]
      if (value === undefined || value === '') missing.push(name)
      else values[name] = value
    }
    if (missing.length > 0) {
      throw validationError(
        `MCP 服务器 "${definition.id}" 引用了未设置的环境变量: ${missing.join(', ')}`,
        { serverId: definition.id, missingEnv: missing },
      )
    }
    return values
  }
}

/** 默认的 `${REPO_ROOT}`：向上找第一个含 package.json 的目录（编译产物也能正确定位）。 */
export function findRepoRoot(startDir: string): string {
  let current = path.resolve(startDir)
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(current, 'package.json'))) return current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(startDir)
}
