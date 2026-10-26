/**
 * 受限运行时的物化器。
 *
 * 静态 profile 内容由 Lead 维护在 `runtime/templates/studio/`（单一事实来源）：
 *   package.json     → 复制到 <home>/profiles/<profile>/package.json
 *   cordis.patch.yml → 替换 {{POLICY_PLUGIN}} {{TOOLS_PLUGIN}} {{AUDIT_PLUGIN}} {{WORKSPACE}}
 *   mcp.cordis.yml   → 仅作参考模板；实际 per-runtime MCP 覆盖层由本文件生成
 *
 * 每个运行时还会生成：
 *   runtime/patches/<runtimeId>/agent.cordis.yml  Agent 系统提示词（per-agent 差异）
 *   runtime/patches/<runtimeId>/mcp.cordis.yml    仅被授权的 MCP 服务器
 *
 * 子进程环境从零构造：只保留 OS 必需变量 + 网关配置的 Provider 凭据。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfig, McpServerConfig, PolicySnapshot } from '@agent-studio/shared'
import { policySnapshotSchema } from '@agent-studio/shared'
import type { GatewayConfig } from '../config.js'
import type { Logger } from '../logger.js'
import { mcpServerName } from './ToolCatalog.js'

/** profile 模板目录（Lead 所有，运行时只读）。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
export const STUDIO_TEMPLATE_DIR = path.resolve(MODULE_DIR, '..', '..', '..', '..', 'runtime', 'templates', 'studio')

/* ------------------------------------------------------------------ 工具函数 */

function atomicWriteFile(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tempPath, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  fs.renameSync(tempPath, filePath)
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key: string) => values[key] ?? '')
}

/** 最小化环境变量：OS 必需项 + DSH_HOME/DSH_AGENTS_HOME + 网关配置。 */
function buildRuntimeEnv(options: {
  config: GatewayConfig
  homeDir: string
  workspaceRoot: string
  /** 业务数据快照目录（每个运行时一份）。 */
  dataDir: string
  policyPath: string
  controlDir: string
  auditPath: string
  catalogPath?: string
  sessionId: string
  userId: string
  agentId: string
  agentVersion: number
  runtimeId: string
}): NodeJS.ProcessEnv {
  const parent = process.env
  const pick = (name: string): string | undefined => {
    const value = parent[name]
    return value === undefined || value === '' ? undefined : value
  }

  const env: NodeJS.ProcessEnv = {
    PATH: pick('PATH') ?? '',
    PATHEXT: pick('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD',
    SYSTEMROOT: pick('SYSTEMROOT') ?? pick('SystemRoot') ?? '',
    WINDIR: pick('WINDIR') ?? '',
    COMSPEC: pick('COMSPEC') ?? '',
    TEMP: path.join(options.homeDir, 'tmp'),
    TMP: path.join(options.homeDir, 'tmp'),
    HOME: options.homeDir,
    USERPROFILE: options.homeDir,
  }
  for (const key of Object.keys(env)) {
    if (env[key] === '') delete env[key]
  }

  Object.assign(env, {
    DSH_HOME: options.homeDir,
    // 两个 home 都必须隔离，否则会读到开发者的 ~/.agents（RESEARCH-PROFILE §4.3）。
    DSH_AGENTS_HOME: path.join(options.homeDir, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: options.config.dshPermissionMode,
    AGENT_STUDIO_POLICY: options.policyPath,
    AGENT_STUDIO_CONTROL_DIR: options.controlDir,
    AGENT_STUDIO_AUDIT_PATH: options.auditPath,
    AGENT_STUDIO_SESSION_ID: options.sessionId,
    AGENT_STUDIO_USER_ID: options.userId,
    AGENT_STUDIO_AGENT_ID: options.agentId,
    AGENT_STUDIO_AGENT_VERSION: String(options.agentVersion),
    AGENT_STUDIO_RUNTIME_ID: options.runtimeId,
    AGENT_STUDIO_WORKSPACE: options.workspaceRoot,
    // 业务工具只读这份 per-runtime 数据快照，不读仓库里的原始文件。
    AGENT_STUDIO_TOOLS_DATA_DIR: options.dataDir,
    AGENT_STUDIO_OUTPUT_DIR: path.join(options.workspaceRoot, '.studio', 'output'),
  })
  if (options.catalogPath !== undefined) env.AGENT_STUDIO_TOOL_CATALOG = options.catalogPath

  // Provider 凭据只来自网关配置：DEEPSEEK_API_KEY（+ MOCK_LLM 的 DEEPSEEK_BASE_URL）。
  Object.assign(env, options.config.provider.extraEnv)
  return env
}

/** 把 Agent 系统提示词写成 per-runtime 覆盖层（config 整块替换）。 */
function renderAgentOverlay(systemPrompt: string): string {
  // JSON 字符串同时是合法的 YAML double-quoted 标量，避免块标量缩进陷阱。
  return `# Generated per runtime: agent persona. The system prompt is deployment
# configuration, never a user message.
- id: system-prompt
  config:
    includeHarnessIdentity: false
    includeRuntimeContext: false
    personaPrefix: ${JSON.stringify(systemPrompt)}
`
}

/** 把一个被授权的 MCP 服务器渲染成 dsh-mcp-client 条目。 */
function renderMcpEntry(server: McpServerConfig, workspaceRoot: string): string {
  const serverName = mcpServerName(server.id)
  const lines: string[] = []
  lines.push(`    - id: mcp-client-${serverName}`)
  lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
  lines.push(`      config:`)
  if (server.transport === 'stdio') {
    lines.push(`        transport: stdio`)
    lines.push(`        serverName: ${JSON.stringify(serverName)}`)
    lines.push(`        command: ${JSON.stringify(server.command ?? '')}`)
    const args = JSON.stringify(server.args ?? [])
    lines.push(`        args: ${args}`)
    lines.push(`        cwd: ${JSON.stringify(toPosix(workspaceRoot))}`)
    const envKeys = (server.envKeys ?? []).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    if (envKeys.length > 0) {
      lines.push(`        env:`)
      for (const key of envKeys) {
        // 密钥在子进程内取值，不落盘（RESEARCH-PROFILE §5）。
        lines.push(`          ${key}: !!js "process.env.${key}"`)
      }
    }
  } else {
    lines.push(`        transport: streamable-http`)
    lines.push(`        serverName: ${JSON.stringify(serverName)}`)
    lines.push(`        url: ${JSON.stringify(server.url ?? '')}`)
  }
  lines.push(`        toolCallTimeoutMs: 30000`)
  lines.push(`        failOnStartupError: false`)
  return `${lines.join('\n')}\n`
}

function renderMcpOverlay(servers: readonly McpServerConfig[], workspaceRoot: string): string {
  if (servers.length === 0) {
    return `# Generated per runtime: no authorized MCP servers.
- insert: []
`
  }
  const entries = servers.map((server) => renderMcpEntry(server, workspaceRoot)).join('')
  return `# Generated per runtime: only the MCP servers authorized by this agent version.
- insert:
${entries}`
}

/* ------------------------------------------------------------------ 物化数据结构 */

export interface MaterializeInput {
  runtimeId: string
  sessionId: string
  userId: string
  agentId: string
  agentVersion: number
  /** 已发布版本的完整配置。 */
  config: AgentConfig
  /** 该版本被授权且处于 enabled 的 MCP 服务器。 */
  mcpServers?: readonly McpServerConfig[]
}

export interface MaterializedRuntime {
  runtimeId: string
  agentId: string
  agentVersion: number
  homeDir: string
  workspaceDir: string
  profileDir: string
  profileName: string
  profilePatchPath: string
  agentPatchPath: string
  mcpPatchPath: string
  homePatchPath: string
  controlDir: string
  auditPath: string
  policyPath: string
  /** 传给 SDK 的有序 --patch 列表（agent 覆盖层 → MCP 覆盖层）。 */
  patches: string[]
  env: NodeJS.ProcessEnv
  systemPrompt: string
}

/* ------------------------------------------------------------------ 物化器 */

export class RuntimeMaterializer {
  constructor(
    private readonly config: GatewayConfig,
    private readonly logger: Logger,
    /** 模板目录；测试可覆盖。 */
    private readonly templateDir: string = STUDIO_TEMPLATE_DIR,
  ) {}

  /** 业务工具目录位置（如已构建）。 */
  private catalogPath(): string | undefined {
    const candidate = path.join(path.dirname(this.config.pluginTools), 'catalog.json')
    return fs.existsSync(candidate) ? candidate : undefined
  }

  private readTemplate(fileName: string): string {
    const candidates = [
      path.join(this.templateDir, fileName),
      path.join(this.config.runtimeDir, 'templates', 'studio', fileName),
      path.join(STUDIO_TEMPLATE_DIR, fileName),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    }
    throw new Error(`restricted profile template not found: ${fileName} (looked in ${candidates.join(', ')})`)
  }

  /**
   * 为每个运行时复制一份业务数据快照到 `<workspace>/.studio/data`。
   *
   * 为什么不直接让工具读仓库里的 `runtime/tools`：
   * 1. 运行时只能看到自己的工作目录（L4 隔离），不能让 Agent 借数据路径反推仓库布局；
   * 2. 数据是"授权快照"，将来要按 Agent 的数据范围（security.dataScope）裁剪，
   *    复制点就是裁剪点；
   * 3. 运行时被删除时，其数据副本一并消失。
   *
   * 源目录优先级：`runtime/tools`（仓库）→ `<runtimeDir>/tools`。
   * @returns 数据目录绝对路径（即使为空目录也返回，工具会给出结构化错误）
   */
  private seedBusinessData(workspaceDir: string): string {
    const dataDir = path.join(workspaceDir, '.studio', 'data')
    fs.mkdirSync(dataDir, { recursive: true })
    const sources = [
      path.resolve(this.templateDir, '..', '..', 'tools'),
      path.join(this.config.runtimeDir, 'tools'),
    ]
    const sourceDir = sources.find((candidate) => fs.existsSync(candidate))
    if (sourceDir === undefined) {
      this.logger.warn('business data seed directory not found', { candidates: sources })
      return dataDir
    }
    let copied = 0
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      fs.copyFileSync(path.join(sourceDir, entry.name), path.join(dataDir, entry.name))
      copied += 1
    }
    this.logger.debug('seeded business data snapshot', { sourceDir, dataDir, files: copied })
    return dataDir
  }

  materialize(input: MaterializeInput): MaterializedRuntime {
    const profileName = this.config.dshProfile
    const runtimeRoot = this.config.runtimeDir
    const homeDir = path.join(runtimeRoot, 'homes', input.runtimeId)
    const workspaceDir = path.join(runtimeRoot, 'workspaces', input.runtimeId)
    const profileDir = path.join(homeDir, 'profiles', profileName)
    const profilePatchPath = path.join(profileDir, 'cordis.patch.yml')
    const homePatchPath = path.join(homeDir, 'cordis.patch.yml')
    const controlDir = path.join(workspaceDir, '.studio', 'control')
    const auditPath = path.join(workspaceDir, '.studio', 'audit', 'tool-calls.jsonl')
    const policyPath = path.join(
      runtimeRoot,
      'policies',
      `${input.agentId}@v${input.agentVersion}`,
      `${input.runtimeId}.json`,
    )
    const patchDir = path.join(runtimeRoot, 'patches', input.runtimeId)
    const agentPatchPath = path.join(patchDir, 'agent.cordis.yml')
    const mcpPatchPath = path.join(patchDir, 'mcp.cordis.yml')

    for (const dir of [
      homeDir,
      path.join(homeDir, 'tmp'),
      path.join(homeDir, 'agents'),
      profileDir,
      workspaceDir,
      path.join(controlDir, 'approvals'),
      path.dirname(auditPath),
      patchDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // home 级 patch 必须是 `[]`（纯注释会让 DSH boot 失败）。
    atomicWriteFile(homePatchPath, '[]\n')

    // 业务数据快照：每个运行时拿到自己的一份，工具只读这份副本。
    const dataDir = this.seedBusinessData(workspaceDir)

    atomicWriteFile(path.join(profileDir, 'package.json'), this.readTemplate('package.json'))
    atomicWriteFile(
      profilePatchPath,
      renderTemplate(this.readTemplate('cordis.patch.yml'), {
        POLICY_PLUGIN: toPosix(this.config.pluginPolicy),
        TOOLS_PLUGIN: toPosix(this.config.pluginTools),
        AUDIT_PLUGIN: toPosix(this.config.pluginAudit),
        WORKSPACE: toPosix(workspaceDir),
      }),
    )

    const systemPrompt = input.config.prompt.system
    atomicWriteFile(agentPatchPath, renderAgentOverlay(systemPrompt))
    atomicWriteFile(mcpPatchPath, renderMcpOverlay(input.mcpServers ?? [], workspaceDir))

    const env = buildRuntimeEnv({
      config: this.config,
      homeDir,
      workspaceRoot: workspaceDir,
      dataDir,
      policyPath,
      controlDir,
      auditPath,
      catalogPath: this.catalogPath(),
      sessionId: input.sessionId,
      userId: input.userId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      runtimeId: input.runtimeId,
    })

    return {
      runtimeId: input.runtimeId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      homeDir,
      workspaceDir,
      profileDir,
      profileName,
      profilePatchPath,
      agentPatchPath,
      mcpPatchPath,
      homePatchPath,
      controlDir,
      auditPath,
      policyPath,
      patches: [agentPatchPath, mcpPatchPath],
      env,
      systemPrompt,
    }
  }

  /**
   * 写不可变策略快照，并返回**生效的**快照。
   *
   * - 同一 runtime 首次物化：写入 0444 只读文件；
   * - 运行时被回收后重新拉起（SDK resume 需要同一个 home/workspace）：
   *   若已有快照的 agentId/version/tools 与本次一致，则复用旧快照，
   *   只更新内存中的 issuedAt，不覆盖磁盘（策略仍是同一份授权）；
   * - 版本/工具集不一致说明会话跨版本复用，直接失败（不做静默降级）。
   */
  writePolicySnapshot(materialized: MaterializedRuntime, snapshot: PolicySnapshot): PolicySnapshot {
    if (fs.existsSync(materialized.policyPath)) {
      const existingRaw = fs.readFileSync(materialized.policyPath, 'utf8')
      let existing: PolicySnapshot
      try {
        existing = policySnapshotSchema.parse(JSON.parse(existingRaw))
      } catch (error) {
        throw new Error(
          `existing policy snapshot is unreadable: ${materialized.policyPath}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const sameAuthorization =
        existing.agentId === snapshot.agentId &&
        existing.agentVersion === snapshot.agentVersion &&
        JSON.stringify(existing.tools) === JSON.stringify(snapshot.tools) &&
        existing.defaultAction === snapshot.defaultAction &&
        existing.controlDir === snapshot.controlDir &&
        existing.auditPath === snapshot.auditPath
      if (!sameAuthorization) {
        throw new Error(
          `policy snapshot already exists with a different authorization: ${materialized.policyPath}`,
        )
      }
      return { ...existing, issuedAt: snapshot.issuedAt }
    }

    const content = `${JSON.stringify(snapshot, null, 2)}\n`
    atomicWriteFile(materialized.policyPath, content, 0o444)
    this.logger.debug('policy snapshot written', {
      policyPath: materialized.policyPath,
      digest: createHash('sha256').update(content).digest('hex').slice(0, 16),
    })
    return snapshot
  }
}
