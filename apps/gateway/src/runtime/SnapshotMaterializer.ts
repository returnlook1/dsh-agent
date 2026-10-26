/**
 * 按 `configKey` 物化运行时快照（docs/SERVICE.md §2 / §4）。
 *
 * 目录布局（**全部按 configKey，不按对话**，回收后才能 resume）：
 *
 * ```
 * <RUNTIME_DIR>/snapshots/<configKey>/
 *   home/                     DSH_HOME（profiles/agent-service、sessions/…）
 *   skills-view/              只含被选中技能的副本
 *   workspace/                cwd / 沙箱根 / 业务数据副本
 *   patches/agent.cordis.yml  系统提示词
 *   patches/mcp.cordis.yml    被选中 MCP 服务器
 * ```
 *
 * 模板由 Lead 维护在 `runtime/templates/agent-service/`（本模块只读），占位符：
 * `{{SKILLS_VIEW}} {{WORKSPACE}} {{TOOLS_PLUGIN}}`。
 *
 * 幂等性：home/workspace 中的数据**绝不删除**（删了会丢 session 历史，resume 就失败）；
 * 每次物化只覆盖 profile/patch 文件，skills-view 仅在技能内容指纹变化时重建。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { AgentConfigSnapshot } from '@agent-studio/shared'
import type { GatewayConfig } from '../config.js'
import type { Logger } from '../logger.js'
import type { McpConfig, McpValueExpr, RuntimeMcpServer } from '../mcp/McpConfig.js'
import type { SkillSource } from '../skills/SkillSource.js'
import type { SkillLocation } from '../skills/SkillSource.js'

const PROFILE_NAME = /^[A-Za-z0-9_-]{1,64}$/
const TOOLS_DATA_SUBDIR = path.join('.studio', 'data')
const TOOLS_OUTPUT_SUBDIR = path.join('.studio', 'output')

/**
 * 空系统提示词时的中性人设。模板里的 `??` 只兜底 `undefined`，所以必须显式给一个
 * 非空默认值，否则模型会拿到空 persona。
 */
export const NEUTRAL_SYSTEM_PROMPT =
  'You are a helpful assistant. Use only the tools and skills provided in this environment.'

export interface MaterializedSnapshot {
  configKey: string
  /** 快照根目录 `<RUNTIME_DIR>/snapshots/<configKey>`。 */
  rootDir: string
  homeDir: string
  skillsViewDir: string
  workspaceDir: string
  patchDir: string
  agentPatchPath: string
  mcpPatchPath: string
  /** 从既有 DSH Profile 导入的 provider 覆盖层。 */
  providerPatchPath: string
  profileName: string
  profileDir: string
  profilePatchPath: string
  /** 子进程环境（从零构造）。 */
  env: NodeJS.ProcessEnv
  skills: string[]
  mcpServers: string[]
}

/** 从既有 DSH Profile 导入的 provider 插件（可选）。 */
export interface ProviderImport {
  /** 要插入到 profile patch 的插件条目（来自源组合）。 */
  entries: ReadonlyArray<{ id: string; name: string; config?: Record<string, unknown> }>
  /** provider 声明的凭据变量实际值（只注入子进程，不落盘）。 */
  env: Record<string, string>
  /** 源 profile 的 node_modules（第三方 provider 插件从这里解析）。 */
  nodeModulesDir?: string
  /** 排障标识：`<home>#<profile>`。 */
  label: string
}

export interface SnapshotMaterializerDeps {
  config: GatewayConfig
  logger: Logger
  skills: SkillSource
  mcp: McpConfig
  /** 模板目录覆盖（测试用临时目录）。 */
  templateDir?: string
  /**
   * "复用既有 DSH 配置"：导入的 provider 插件。
   * 返回 undefined = 只用模板自带的基础组合。
   */
  providerImport?: () => ProviderImport | undefined
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => values[key] ?? match)
}

/** 技能内容指纹：路径 + mtime + size（技能改动后 skills-view 自动重建）。 */
function fingerprint(locations: readonly SkillLocation[]): string {
  const parts: string[] = []
  const visit = (target: string): void => {
    let stat: fs.Stats
    try {
      stat = fs.statSync(target)
    } catch {
      return
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        visit(path.join(target, entry.name))
      }
      return
    }
    parts.push(`${target}:${stat.size}:${stat.mtimeMs}`)
  }
  for (const location of locations) visit(location.path)
  return parts.join('|')
}

/**
 * 从零构造子进程环境：只保留 OS 必需变量 + DSH home + 服务注入项 + Provider 凭据。
 * **绝不继承**宿主 `DSH_HOME` / `DSH_PROFILE` / 代理变量（HTTP_PROXY 等）。
 */
export function buildRuntimeEnv(options: {
  config: GatewayConfig
  snapshot: { homeDir: string; workspaceDir: string; skillsViewDir: string; configKey: string; agentPatchPath: string; mcpPatchPath: string }
  profileName: string
  systemPrompt: string
  toolsDataDir: string
  outputDir: string
  /** 需要注入的 MCP 凭据环境变量（只含被选中服务器引用的名字）。 */
  mcpEnv?: Record<string, string>
  /** 需要注入的 provider 凭据环境变量（从既有 DSH 配置导入时）。 */
  providerEnv?: Record<string, string>
  parentEnv?: NodeJS.ProcessEnv
}): NodeJS.ProcessEnv {
  const parent = options.parentEnv ?? process.env
  const pick = (name: string): string | undefined => {
    const value = parent[name]
    return value === undefined || value === '' ? undefined : value
  }

  const env: NodeJS.ProcessEnv = {}
  const assign = (name: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') env[name] = value
  }

  // 1) OS 必需项（只透传，不扩大）
  assign('PATH', pick('PATH'))
  assign('PATHEXT', pick('PATHEXT'))
  assign('SYSTEMROOT', pick('SYSTEMROOT') ?? pick('SystemRoot'))
  assign('WINDIR', pick('WINDIR'))
  assign('COMSPEC', pick('COMSPEC'))
  // 2) 临时目录与 home 一律落在快照内
  const tmpDir = path.join(options.snapshot.homeDir, 'tmp')
  assign('TEMP', tmpDir)
  assign('TMP', tmpDir)
  assign('HOME', options.snapshot.homeDir)
  assign('USERPROFILE', options.snapshot.homeDir)
  // 3) DSH home 隔离
  assign('DSH_HOME', options.snapshot.homeDir)
  assign('DSH_AGENTS_HOME', path.join(options.snapshot.homeDir, 'agents'))
  assign('DSH_TELEMETRY_DISABLED', '1')
  // 4) 服务注入项（运行时插件 / 排障用）
  assign('AGENT_SERVICE_DSH_PROFILE', options.profileName)
  assign('AGENT_SERVICE_CONFIG_KEY', options.snapshot.configKey)
  assign('AGENT_SERVICE_WORKSPACE', options.snapshot.workspaceDir)
  assign('AGENT_SERVICE_SKILLS_VIEW', options.snapshot.skillsViewDir)
  assign('AGENT_SERVICE_PATCH_DIR', path.dirname(options.snapshot.agentPatchPath))
  assign('AGENT_SERVICE_AGENT_PATCH', options.snapshot.agentPatchPath)
  assign('AGENT_SERVICE_MCP_PATCH', options.snapshot.mcpPatchPath)
  assign('AGENT_SERVICE_TOOLS_DATA_DIR', options.toolsDataDir)
  assign('AGENT_SERVICE_OUTPUT_DIR', options.outputDir)
  assign('AGENT_SERVICE_PLUGIN_TOOLS', options.config.pluginTools)
  // 系统提示词：空时给中性默认值（模板的 `??` 兜不住空串）。
  assign(
    'AGENT_SERVICE_SYSTEM_PROMPT',
    options.systemPrompt.trim() === '' ? NEUTRAL_SYSTEM_PROMPT : options.systemPrompt,
  )
  // 5) 示例业务工具插件读的是旧变量名（plugins/ 由 Lead 维护，服务侧只负责喂值）。
  assign('AGENT_STUDIO_TOOLS_DATA_DIR', options.toolsDataDir)
  assign('AGENT_STUDIO_OUTPUT_DIR', options.outputDir)
  assign('AGENT_STUDIO_ALLOWED_STATIONS', pick('AGENT_STUDIO_ALLOWED_STATIONS'))
  // 6) Provider 凭据
  assign('DEEPSEEK_API_KEY', options.config.provider.apiKey)
  assign('DEEPSEEK_BASE_URL', options.config.provider.baseUrl)
  // 7) MCP 凭据：**只注入被引用的变量**，由渲染出的 `!!js` 表达式在子进程里取值
  for (const [name, value] of Object.entries(options.mcpEnv ?? {})) assign(name, value)
  // 8) 从既有 DSH 配置导入的 provider 凭据（同样只进环境，不落盘）
  for (const [name, value] of Object.entries(options.providerEnv ?? {})) assign(name, value)
  return env
}

/** 渲染系统提示词覆盖层（`config` 是整块替换，三个键一起写）。 */
export function renderAgentPatch(systemPrompt: string): string {
  if (systemPrompt.trim() === '') {
    return '# 未配置系统提示词：使用模板中的默认人设。\n[]\n'
  }
  return [
    '# 由 DSH Agent Service 生成：该快照的系统提示词（部署配置，不是用户消息）。',
    '# system-prompt 的 config 是整块替换，所以 include* 一并写全。',
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: false',
    '    includeRuntimeContext: false',
    `    personaPrefix: ${JSON.stringify(systemPrompt)}`,
    '',
  ].join('\n')
}

/** 把值表达式渲染成 YAML 标量：字面量走 JSON 引号，引用走 `!!js`（在子进程里求值）。 */
export function renderMcpValue(expr: McpValueExpr): string {
  if (expr.kind === 'literal') return JSON.stringify(expr.value)
  if (expr.kind === 'env') return `!!js ${JSON.stringify(`process.env.${expr.name} ?? ''`)}`
  const body = expr.template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => `\${process.env.${name} ?? ''}`)
  return `!!js ${JSON.stringify(`\`${body}\``)}`
}

function renderMcpEntry(server: RuntimeMcpServer, workspaceDir: string): string[] {
  const lines: string[] = []
  lines.push(`    - id: ${JSON.stringify(`mcp-client-${server.id}`)}`)
  lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`)
  lines.push(`      config:`)
  lines.push(`        transport: ${server.transport}`)
  lines.push(`        serverName: ${JSON.stringify(server.serverName)}`)
  if (server.transport === 'stdio') {
    lines.push(`        command: ${JSON.stringify(server.command ?? '')}`)
    lines.push(`        args: ${JSON.stringify(server.args)}`)
    lines.push(`        cwd: ${JSON.stringify(toPosix(workspaceDir))}`)
    if (Object.keys(server.env).length > 0) {
      lines.push(`        env:`)
      for (const [key, expr] of Object.entries(server.env)) lines.push(`          ${key}: ${renderMcpValue(expr)}`)
    }
  } else {
    lines.push(`        url: ${JSON.stringify(server.url ?? '')}`)
    if (Object.keys(server.headers).length > 0) {
      lines.push(`        headers:`)
      for (const [key, expr] of Object.entries(server.headers)) lines.push(`          ${key}: ${renderMcpValue(expr)}`)
    }
  }
  lines.push(`        toolCallTimeoutMs: ${server.toolCallTimeoutMs}`)
  lines.push(`        failOnStartupError: ${server.failOnStartup}`)
  return lines
}

/** 判断是否是"保留的 JS 表达式"（从源组合里解析出来的 `!!js`）。 */
function isJsExpression(value: unknown): value is { __jsExpr: string } {
  return value !== null && typeof value === 'object' && typeof (value as { __jsExpr?: unknown }).__jsExpr === 'string'
}

function yamlScalar(value: unknown): string {
  if (isJsExpression(value)) {
    const expr = value.__jsExpr
    // 多行表达式（源里的 `>-` 折叠块）用 JSON 引号包成一行，标签仍然生效。
    return /\n/.test(expr) ? `!!js ${JSON.stringify(expr)}` : `!!js ${expr}`
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  return JSON.stringify(value)
}

/** 把任意 JSON 值渲染成块状 YAML（只用于 provider 条目，键顺序保持）。 */
function yamlLines(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    if (value.every((item) => item === null || typeof item !== 'object')) {
      return [`${pad}[${value.map((item) => yamlScalar(item)).join(', ')}]`]
    }
    const lines: string[] = []
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item) && !isJsExpression(item)) {
        const child = yamlLines(item, indent + 2)
        lines.push(`${pad}- ${(child[0] ?? '').trimStart()}`)
        lines.push(...child.slice(1))
      } else {
        lines.push(`${pad}- ${yamlScalar(item)}`)
      }
    }
    return lines
  }
  if (value !== null && typeof value === 'object' && !isJsExpression(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    const lines: string[] = []
    for (const [key, child] of entries) {
      if (child !== null && typeof child === 'object' && !isJsExpression(child)) {
        lines.push(`${pad}${key}:`)
        lines.push(...yamlLines(child, indent + 2))
      } else {
        lines.push(`${pad}${key}: ${yamlScalar(child)}`)
      }
    }
    return lines
  }
  return [`${pad}${yamlScalar(value)}`]
}

/**
 * 渲染"从既有 DSH Profile 导入的 provider 插件"覆盖层。
 * 源组合里带 `!!js` 的配置会原样还原成表达式（不落任何求值后的值）。
 */
export function renderProviderPatch(imported: ProviderImport): string {
  if (imported.entries.length === 0) {
    return '# 未从既有 DSH Profile 导入 provider。\n[]\n'
  }
  const lines = [
    `# 从既有 DSH Profile 导入（${imported.label}）：provider 插件`,
    '# 这些条目来自源组合，`!!js` 表达式保持原样，不写入任何求值结果。',
    '- insert:',
  ]
  for (const entry of imported.entries) {
    lines.push(`    - id: ${JSON.stringify(entry.id)}`)
    lines.push(`      name: ${JSON.stringify(entry.name)}`)
    if (entry.config !== undefined && Object.keys(entry.config).length > 0) {
      lines.push('      config:')
      lines.push(...yamlLines(entry.config, 8))
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 渲染 MCP 覆盖层。
 *
 * 关键：文件里**只有引用**（`!!js process.env.X`），没有真实凭据；
 * 值在 DSH 子进程启动时求值，环境变量由服务按白名单注入。
 */
export function renderMcpPatch(servers: readonly RuntimeMcpServer[], workspaceDir: string): string {
  if (servers.length === 0) return '# 未选中任何 MCP 服务器。\n[]\n'
  const lines = ['# 由 DSH Agent Service 生成：MCP 服务器（凭据以 !!js 引用表达，不落盘）', '- insert:']
  for (const server of servers) lines.push(...renderMcpEntry(server, workspaceDir))
  lines.push('')
  return `${lines.join('\n')}\n`
}
export class SnapshotMaterializer {
  constructor(private readonly deps: SnapshotMaterializerDeps) {}

  private get templateDir(): string {
    return this.deps.templateDir ?? this.deps.config.templateDir
  }

  private readTemplate(fileName: string): string {
    const candidates = [
      path.join(this.templateDir, fileName),
      path.join(this.deps.config.runtimeDir, 'templates', 'agent-service', fileName),
    ]
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8')
    }
    throw new Error(
      `agent-service profile 模板缺失: ${fileName}（查找位置: ${candidates.join(', ')}）`,
    )
  }

  snapshotPaths(configKey: string): Pick<
    MaterializedSnapshot,
    'configKey' | 'rootDir' | 'homeDir' | 'skillsViewDir' | 'workspaceDir' | 'patchDir' | 'agentPatchPath' | 'mcpPatchPath' | 'providerPatchPath' | 'profileName' | 'profileDir' | 'profilePatchPath'
  > {
    const profileName = this.deps.config.dshProfile
    if (!PROFILE_NAME.test(profileName)) {
      throw new Error(`非法的 profile 名: ${JSON.stringify(profileName)}`)
    }
    const rootDir = path.join(this.deps.config.runtimeDir, 'snapshots', configKey)
    const homeDir = path.join(rootDir, 'home')
    const patchDir = path.join(rootDir, 'patches')
    const profileDir = path.join(homeDir, 'profiles', profileName)
    return {
      configKey,
      rootDir,
      homeDir,
      skillsViewDir: path.join(rootDir, 'skills-view'),
      workspaceDir: path.join(rootDir, 'workspace'),
      patchDir,
      agentPatchPath: path.join(patchDir, 'agent.cordis.yml'),
      mcpPatchPath: path.join(patchDir, 'mcp.cordis.yml'),
      providerPatchPath: path.join(patchDir, 'providers.cordis.yml'),
      profileName,
      profileDir,
      profilePatchPath: path.join(profileDir, 'cordis.patch.yml'),
    }
  }

  /** 业务工具数据副本：只复制文件，不删 workspace 里已有的东西。 */
  private seedToolsData(workspaceDir: string): string {
    const dataDir = path.join(workspaceDir, TOOLS_DATA_SUBDIR)
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(path.join(workspaceDir, TOOLS_OUTPUT_SUBDIR), { recursive: true })
    const sourceDir = this.deps.config.toolsDataDir
    if (!fs.existsSync(sourceDir)) {
      this.deps.logger.debug('tools: data source not found; empty snapshot data dir', { sourceDir })
      return dataDir
    }
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue
      fs.copyFileSync(path.join(sourceDir, entry.name), path.join(dataDir, entry.name))
    }
    return dataDir
  }

  /**
   * 让快照 profile 能解析源 profile 的插件：在 `<profile>/node_modules` 建 junction。
   * Windows 上目录 junction 不需要管理员权限；已存在则跳过。
   */
  private linkProfileNodeModules(profileDir: string, sourceNodeModules: string): void {
    const target = path.join(profileDir, 'node_modules')
    if (fs.existsSync(target)) return
    if (!fs.existsSync(sourceNodeModules)) {
      this.deps.logger.warn('provider import: source node_modules missing', { sourceNodeModules })
      return
    }
    try {
      fs.symlinkSync(sourceNodeModules, target, 'junction')
    } catch (error) {
      this.deps.logger.warn('provider import: linking node_modules failed', {
        sourceNodeModules,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  materialize(snapshot: AgentConfigSnapshot): MaterializedSnapshot {
    const paths = this.snapshotPaths(snapshot.configKey)
    const logger = this.deps.logger.child({ configKey: snapshot.configKey })

    for (const dir of [
      paths.homeDir,
      path.join(paths.homeDir, 'tmp'),
      path.join(paths.homeDir, 'agents'),
      paths.profileDir,
      paths.workspaceDir,
      paths.skillsViewDir,
      paths.patchDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true })
    }

    // 技能：先校验（未知技能抛 SKILL_UNKNOWN），再按内容指纹决定是否重建副本。
    const locations = this.deps.skills.locate(snapshot.skills)
    const markerPath = path.join(paths.rootDir, '.materialized.json')
    const nextFingerprint = fingerprint(locations)
    let previousFingerprint: string | undefined
    try {
      previousFingerprint = (JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { skillsFingerprint?: string })
        .skillsFingerprint
    } catch {
      previousFingerprint = undefined
    }
    if (previousFingerprint !== nextFingerprint) {
      this.deps.skills.copyInto(snapshot.skills, paths.skillsViewDir)
    } else {
      logger.debug('skills-view unchanged; reusing copy')
    }

    const toolsDataDir = this.seedToolsData(paths.workspaceDir)
    if (!fs.existsSync(this.deps.config.pluginTools)) {
      logger.warn('tools: plugin entry not found (run the plugin build before starting runtimes)', {
        pluginTools: this.deps.config.pluginTools,
      })
    }

    // profile：package.json + cordis.patch.yml（替换三个占位符）
    const substitutions = {
      SKILLS_VIEW: toPosix(paths.skillsViewDir),
      WORKSPACE: toPosix(paths.workspaceDir),
      TOOLS_PLUGIN: toPosix(this.deps.config.pluginTools),
    }
    // profile 模板由 Lead 维护；从既有 DSH 配置导入的 provider 作为独立 patch 叠加。
    fs.writeFileSync(path.join(paths.profileDir, 'package.json'), renderTemplate(this.readTemplate('package.json'), substitutions), 'utf8')
    fs.writeFileSync(paths.profilePatchPath, renderTemplate(this.readTemplate('cordis.patch.yml'), substitutions), 'utf8')
    // home 级 patch 必须是合法数组（纯注释会让 DSH boot 失败）。
    fs.writeFileSync(path.join(paths.homeDir, 'cordis.patch.yml'), '[]\n', 'utf8')

    // provider 导入（可选）：patch + node_modules junction + 凭据环境
    const providerImport = this.deps.providerImport?.()
    const providerEnv: Record<string, string> = {}
    if (providerImport !== undefined) {
      fs.writeFileSync(paths.providerPatchPath, renderProviderPatch(providerImport), 'utf8')
      if (providerImport.nodeModulesDir !== undefined) {
        this.linkProfileNodeModules(paths.profileDir, providerImport.nodeModulesDir)
      }
      Object.assign(providerEnv, providerImport.env)
      logger.info('provider import applied', {
        label: providerImport.label,
        entries: providerImport.entries.length,
        credentials: Object.keys(providerImport.env).length,
        nodeModules: providerImport.nodeModulesDir,
      })
    } else {
      fs.writeFileSync(paths.providerPatchPath, '# 未启用 provider 导入。\n[]\n', 'utf8')
    }

    // 每个快照的差异层：系统提示词 + 被选中的 MCP
    const mcpServers = this.deps.mcp.assertKnown(snapshot.mcpServers)
    const resolved = mcpServers.map((server) => this.deps.mcp.resolveForRuntime(server))
    const mcpEnv: Record<string, string> = {}
    for (const server of mcpServers) Object.assign(mcpEnv, this.deps.mcp.envFor(server))
    fs.writeFileSync(paths.agentPatchPath, renderAgentPatch(snapshot.systemPrompt), 'utf8')
    fs.writeFileSync(paths.mcpPatchPath, renderMcpPatch(resolved, paths.workspaceDir), 'utf8')

    fs.writeFileSync(
      markerPath,
      `${JSON.stringify({ configKey: snapshot.configKey, skillsFingerprint: nextFingerprint, materializedAt: Date.now() }, null, 2)}\n`,
      'utf8',
    )

    const env = buildRuntimeEnv({
      config: this.deps.config,
      snapshot: {
        homeDir: paths.homeDir,
        workspaceDir: paths.workspaceDir,
        skillsViewDir: paths.skillsViewDir,
        configKey: paths.configKey,
        agentPatchPath: paths.agentPatchPath,
        mcpPatchPath: paths.mcpPatchPath,
      },
      profileName: paths.profileName,
      systemPrompt: snapshot.systemPrompt,
      toolsDataDir,
      outputDir: path.join(paths.workspaceDir, TOOLS_OUTPUT_SUBDIR),
      mcpEnv,
      providerEnv,
    })

    return {
      ...paths,
      env,
      skills: [...snapshot.skills],
      mcpServers: [...snapshot.mcpServers],
    }
  }

  /** 删除某个快照（排障用；服务运行时不自动调用）。 */
  remove(configKey: string): void {
    fs.rmSync(path.join(this.deps.config.runtimeDir, 'snapshots', configKey), { recursive: true, force: true })
  }
}