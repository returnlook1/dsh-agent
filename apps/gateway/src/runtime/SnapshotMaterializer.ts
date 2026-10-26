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
import type { McpConfig, ResolvedMcpServer } from '../mcp/McpConfig.js'
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
  profileName: string
  profileDir: string
  profilePatchPath: string
  /** 子进程环境（从零构造）。 */
  env: NodeJS.ProcessEnv
  skills: string[]
  mcpServers: string[]
}

export interface SnapshotMaterializerDeps {
  config: GatewayConfig
  logger: Logger
  skills: SkillSource
  mcp: McpConfig
  /** 模板目录覆盖（测试用临时目录）。 */
  templateDir?: string
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
  // 6) Provider 凭据（唯一允许进入子进程的秘密）
  assign('DEEPSEEK_API_KEY', options.config.provider.apiKey)
  assign('DEEPSEEK_BASE_URL', options.config.provider.baseUrl)
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

/** 一个 MCP server → 一个 dsh-mcp-client 条目（形状对齐 scripts/check-runtime.mjs）。 */
function mcpEntry(server: ResolvedMcpServer, workspaceDir: string): Record<string, unknown> {
  const config: Record<string, unknown> = {
    transport: server.transport,
    serverName: server.id,
  }
  if (server.transport === 'stdio') {
    config.command = server.command
    config.args = server.args
    config.env = server.env
    config.cwd = toPosix(workspaceDir)
  } else {
    config.url = server.url
    config.headers = server.headers
  }
  config.toolCallTimeoutMs = server.toolCallTimeoutMs
  config.failOnStartupError = server.failOnStartup
  return {
    id: `mcp-client-${server.id}`,
    name: '@deepseek-ai/dsh-mcp-client',
    config,
  }
}

/** 渲染 MCP 覆盖层；没有选中任何服务器时写顶层空数组（`parsePatchList` 要求数组）。 */
export function renderMcpPatch(servers: readonly ResolvedMcpServer[], workspaceDir: string): string {
  if (servers.length === 0) return '# 未选中任何 MCP 服务器。\n[]\n'
  return YAML.stringify([{ insert: servers.map((server) => mcpEntry(server, workspaceDir)) }], {
    lineWidth: 0,
  })
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
    'configKey' | 'rootDir' | 'homeDir' | 'skillsViewDir' | 'workspaceDir' | 'patchDir' | 'agentPatchPath' | 'mcpPatchPath' | 'profileName' | 'profileDir' | 'profilePatchPath'
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
    fs.writeFileSync(path.join(paths.profileDir, 'package.json'), renderTemplate(this.readTemplate('package.json'), substitutions), 'utf8')
    fs.writeFileSync(paths.profilePatchPath, renderTemplate(this.readTemplate('cordis.patch.yml'), substitutions), 'utf8')
    // home 级 patch 必须是合法数组（纯注释会让 DSH boot 失败）。
    fs.writeFileSync(path.join(paths.homeDir, 'cordis.patch.yml'), '[]\n', 'utf8')

    // 每个快照的差异层：系统提示词 + 被选中的 MCP
    const mcpServers = this.deps.mcp.assertKnown(snapshot.mcpServers)
    const resolved = mcpServers.map((server) => this.deps.mcp.resolve(server))
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
