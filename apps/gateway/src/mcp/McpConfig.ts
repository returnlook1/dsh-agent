/**
 * `config/mcp-servers.json` 的读取、校验与占位符解析（docs/SERVICE.md §3.2）。
 *
 * 占位符规则：
 * - `${ENV_NAME}`：从**服务进程环境**读取；解析不到（未设置或空串）直接报错，
 *   绝不写空值；
 * - `${REPO_ROOT}`：始终可用，等于根 `package.json` 所在目录（Lead 提供的约定）。
 *   它先于环境变量解析，所以不会被同名环境变量覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { McpServerDefinition, McpServerSummaryDto } from '@agent-studio/shared'
import { mcpServerDefinitionSchema } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import { ApiError } from '../http/errors.js'

const fileSchema = z.object({
  servers: z.array(mcpServerDefinitionSchema).default([]),
})

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/** 解析后的 MCP 服务器（`${ENV}` 已展开）。 */
export interface ResolvedMcpServer extends McpServerDefinition {
  env: Record<string, string>
  headers: Record<string, string>
}

/**
 * 展开占位符。`available` 提供"总是可用"的变量（如 REPO_ROOT）。
 * 未解析到 → 抛错（fail closed）。
 */
export function resolvePlaceholders(
  value: string,
  options: { env: NodeJS.ProcessEnv; available?: Record<string, string>; what: string },
): string {
  return value.replace(PLACEHOLDER, (_match, name: string) => {
    const fromAvailable = options.available?.[name]
    if (fromAvailable !== undefined && fromAvailable !== '') return fromAvailable
    const fromEnv = options.env[name]
    if (fromEnv === undefined || fromEnv === '') {
      throw new Error(`${options.what} 引用了未设置的环境变量 ${name}（${value}）`)
    }
    return fromEnv
  })
}

export class McpConfig {
  private definitionsCache: { mtimeMs: number; size: number; servers: McpServerDefinition[] } | undefined

  constructor(
    private readonly options: {
      configPath: string
      logger: Logger
      /** 服务进程环境（测试可注入）。 */
      env?: NodeJS.ProcessEnv
      /** `${REPO_ROOT}` 的值（默认取仓库根目录）。 */
      repoRoot: string
    },
  ) {}

  get configPath(): string {
    return this.options.configPath
  }

  private get env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env
  }

  /** 读取并校验；文件缺失 → 空清单（不是错误：能力清单可以为空）。 */
  definitions(): McpServerDefinition[] {
    if (!fs.existsSync(this.options.configPath)) {
      this.options.logger.warn('mcp: config file not found; no servers available', {
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
    if (this.definitionsCache !== undefined && this.definitionsCache.mtimeMs === stat.mtimeMs && this.definitionsCache.size === stat.size) {
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

  /** GET /api/mcp-servers（全部条目，含 enabled 标记）。 */
  summaries(): McpServerSummaryDto[] {
    return this.definitions().map((server) => ({
      id: server.id,
      name: server.name,
      ...(server.description === undefined ? {} : { description: server.description }),
      transport: server.transport,
      enabled: server.enabled,
    }))
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

  /** 展开 `${ENV}` / `${REPO_ROOT}`；解析不到直接抛错（不写空值）。 */
  resolve(definition: McpServerDefinition): ResolvedMcpServer {
    // REPO_ROOT 统一给正斜杠：Windows 路径也能直接作为 node 参数（与 check-runtime 一致）。
    const available = { REPO_ROOT: this.options.repoRoot.replaceAll('\\', '/') }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(definition.env)) {
      env[key] = resolvePlaceholders(value, {
        env: this.env,
        available,
        what: `MCP 服务器 "${definition.id}" 的 env.${key}`,
      })
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(definition.headers)) {
      headers[key] = resolvePlaceholders(value, {
        env: this.env,
        available,
        what: `MCP 服务器 "${definition.id}" 的 headers.${key}`,
      })
    }
    const args = definition.args.map((arg) =>
      resolvePlaceholders(arg, { env: this.env, available, what: `MCP 服务器 "${definition.id}" 的 args` }),
    )
    const command =
      definition.command === undefined
        ? undefined
        : resolvePlaceholders(definition.command, {
            env: this.env,
            available,
            what: `MCP 服务器 "${definition.id}" 的 command`,
          })
    const url =
      definition.url === undefined
        ? undefined
        : resolvePlaceholders(definition.url, {
            env: this.env,
            available,
            what: `MCP 服务器 "${definition.id}" 的 url`,
          })

    if (definition.transport === 'stdio' && (command === undefined || command === '')) {
      throw new Error(`MCP 服务器 "${definition.id}" 使用 stdio 但缺少 command`)
    }
    if (definition.transport === 'streamable-http' && (url === undefined || url === '')) {
      throw new Error(`MCP 服务器 "${definition.id}" 使用 streamable-http 但缺少 url`)
    }

    return {
      ...definition,
      ...(command === undefined ? {} : { command }),
      ...(url === undefined ? {} : { url }),
      args,
      env,
      headers,
    }
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
