/**
 * 能力来源与在线管理（Skill / MCP）。
 *
 * 设计边界：
 * - **Skill** 本质是文件系统约定（`<root>/<name>/SKILL.md`），所以"新建"就是写这个文件；
 * - **MCP** 是 `config/mcp-servers.json` 里的一条定义，所以"新增/修改"就是合并这个 JSON；
 * - 两者都不引入数据库：删掉文件/条目就消失，便于用 Git 管理。
 *
 * 安全：只写配置里的目录与文件，名字/ID 走严格白名单，写文件用临时文件 + rename；
 * 打开目录/文件只在允许本地操作时生效（`AGENT_SERVICE_ALLOW_LOCAL_ACTIONS`）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type {
  CapabilitySourcesResponse,
  CreateSkillRequest,
  McpServerDefinition,
  SkillSummaryDto,
} from '@agent-studio/shared'
import { mcpServerDefinitionSchema } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import { ApiError, conflict, notFound, validationError } from '../http/errors.js'
import type { SkillCatalog } from '../skills/Catalog.js'

export interface CapabilityFilesOptions {
  skillsDirs: readonly string[]
  mcpConfigPath: string
  /** 是否允许"打开目录/文件"等本地动作（默认 true，仅本机使用）。 */
  allowLocalActions: boolean
  /** 从既有 DSH Profile 导入 MCP 时的标识（只读展示）。 */
  dshSourceLabel: string | undefined
  logger: Logger
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/

/** 技能 Markdown 模板（新建时没有正文就用它）。 */
function defaultSkillBody(name: string, description: string): string {
  return [
    `# ${name}`,
    '',
    description,
    '',
    '## 何时使用',
    '',
    '- 说明触发条件；这段会进入模型的技能描述。',
    '',
    '## 步骤',
    '',
    '1. 先确认输入数据与范围；',
    '2. 给出结论与依据；',
    '3. 不确定的数据要显式说明。',
    '',
  ].join('\n')
}

export class CapabilityFiles {
  constructor(
    private readonly options: CapabilityFilesOptions,
    private readonly catalog: SkillCatalog,
  ) {}

  /* ------------------------------------------------------------ 来源概览 */

  /** GET /api/capabilities/sources */
  sources(): CapabilitySourcesResponse {
    const skills = this.catalog.list()
    const roots = this.catalog.roots().map((root) => {
      const count = skills.filter(
        (skill) =>
          skill.path !== undefined &&
          path.resolve(skill.path).startsWith(path.resolve(root.path) + path.sep),
      ).length
      return {
        path: root.path,
        source: root.source,
        label: root.source === 'project' ? '项目技能目录' : root.source === 'user' ? 'DSH 用户技能' : '自定义目录',
        count,
        writable: this.isWritableDir(root.path),
      }
    })
    const writableRoot = roots.find((root) => root.writable)?.path
    const localDefinitions = this.readLocalDefinitions()
    return {
      skills: {
        roots,
        total: skills.length,
        ...(writableRoot === undefined ? {} : { writableRoot }),
      },
      mcp: {
        configPath: this.options.mcpConfigPath,
        exists: fs.existsSync(this.options.mcpConfigPath),
        localCount: localDefinitions.length,
        ...(this.options.dshSourceLabel === undefined ? {} : { dshSource: this.options.dshSourceLabel }),
      },
      actions: { enabled: this.options.allowLocalActions, reveal: this.options.allowLocalActions },
    }
  }

  /* --------------------------------------------------------------- Skill */

  /**
   * 新建技能：写入 `<writableRoot>/<name>/SKILL.md`。
   * @throws ApiError 名字非法 / 重名 / 没有可写根目录
   */
  createSkill(input: CreateSkillRequest): SkillSummaryDto {
    const name = input.name.trim()
    if (!SKILL_NAME.test(name)) {
      throw validationError('技能名字只允许小写字母、数字、点、下划线与连字符（1–64 字符）', { name })
    }
    if (this.catalog.get(name) !== undefined) {
      throw conflict(`技能已存在: ${name}`, { name })
    }
    const root = this.writableSkillsRoot()
    const dir = path.join(root, name)
    const file = path.join(dir, 'SKILL.md')
    if (fs.existsSync(dir)) throw conflict(`技能目录已存在: ${dir}`, { name })

    const description = input.description.trim()
    if (description.length === 0) throw validationError('技能描述不能为空', { name })
    const frontmatter: Record<string, unknown> = { name, description }
    const whenToUse = input.whenToUse?.trim()
    if (whenToUse !== undefined && whenToUse.length > 0) frontmatter.whenToUse = whenToUse

    const body = input.body?.trim()
    const content = `---\n${YAML.stringify(frontmatter)}---\n\n${
      body === undefined || body.length === 0 ? defaultSkillBody(name, description) : body
    }\n`
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
    this.catalog.invalidate()

    const created = this.catalog.get(name)
    if (created === undefined) {
      throw new ApiError('INTERNAL_ERROR', '技能已写入但解析失败，请检查 SKILL.md 的 frontmatter')
    }
    this.options.logger.info('skill created', { name, file })
    return created
  }

  /** 删除技能（只允许删除可写根目录下的目录形态技能）。 */
  deleteSkill(name: string): void {
    const skill = this.catalog.get(name)
    if (skill === undefined) throw notFound(`技能不存在: ${name}`)
    if (skill.path === undefined) {
      throw validationError('技能缺少文件路径，无法删除', { name })
    }
    const root = this.writableSkillsRoot()
    const dir = path.join(root, name)
    const resolved = path.resolve(skill.path)
    if (!resolved.startsWith(path.resolve(root) + path.sep)) {
      throw validationError('该技能不在可写目录，不能从界面删除', { name, path: skill.path })
    }
    fs.rmSync(resolved.endsWith('SKILL.md') ? dir : resolved, { recursive: true, force: true })
    this.catalog.invalidate()
    this.options.logger.info('skill deleted', { name, path: skill.path })
  }

  /* ----------------------------------------------------------------- MCP */

  /**
   * 新增/修改 MCP 定义（写回 `config/mcp-servers.json`，按 id 覆盖）。
   * @throws ApiError 定义非法
   */
  upsertMcpServer(definition: McpServerDefinition): McpServerDefinition {
    const parsed = mcpServerDefinitionSchema.safeParse(definition)
    if (!parsed.success) {
      throw validationError('MCP 定义校验失败', {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      })
    }
    // 未修改的条目保持原始 JSON 形态（避免把默认值写进别人的配置造成无谓 diff）。
    const raw = this.readRawServers()
    const existing = this.readLocalDefinitions()
    const index = existing.findIndex((server) => server.id === parsed.data.id)
    const next = [...raw]
    if (index >= 0) next[index] = parsed.data
    else next.push(parsed.data)
    this.writeRawServers(next)
    this.options.logger.info('mcp definition saved', { serverId: parsed.data.id, replaced: index >= 0 })
    return parsed.data
  }

  /** 删除本地配置文件里的定义（DSH Profile 导入的只读条目不在其中）。 */
  deleteMcpServer(id: string): void {
    const raw = this.readRawServers()
    const before = this.readLocalDefinitions()
    const next = raw.filter((entry, index) => before[index]?.id !== id)
    if (next.length === raw.length) {
      throw notFound(`配置文件中没有该 MCP 服务器: ${id}`)
    }
    this.writeRawServers(next)
    this.options.logger.info('mcp definition deleted', { serverId: id })
  }

  /* ----------------------------------------------------------- 本地动作 */

  /** 在资源管理器里打开技能目录或 MCP 配置文件（仅本机）。 */
  reveal(target: 'skills' | 'mcp'): { opened: string } {
    if (!this.options.allowLocalActions) {
      throw new ApiError(
        'LOCAL_ACTIONS_DISABLED',
        '本地动作已禁用（AGENT_SERVICE_ALLOW_LOCAL_ACTIONS=off）',
      )
    }
    const opened = target === 'skills' ? this.writableSkillsRoot() : this.options.mcpConfigPath
    if (target === 'mcp' && !fs.existsSync(opened)) {
      fs.mkdirSync(path.dirname(opened), { recursive: true })
      fs.writeFileSync(opened, `${JSON.stringify({ servers: [] }, null, 2)}\n`, 'utf8')
    }
    const args = process.platform === 'win32' && target === 'mcp' ? ['/select,', opened] : [opened]
    try {
      const child = spawn(this.platformOpener(), args, { detached: true, stdio: 'ignore' })
      child.unref()
    } catch (error) {
      throw new ApiError('INTERNAL_ERROR', `无法打开: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.options.logger.info('capability reveal', { target, opened })
    return { opened }
  }

  /* -------------------------------------------------------------- 内部 */

  private platformOpener(): string {
    if (process.platform === 'win32') return 'explorer.exe'
    if (process.platform === 'darwin') return 'open'
    return 'xdg-open'
  }

  private isWritableDir(dir: string): boolean {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return true
    } catch {
      return false
    }
  }

  /** 第一个可写技能根（默认是 `SKILLS_DIRS` 的第一个）。 */
  private writableSkillsRoot(): string {
    for (const dir of this.options.skillsDirs) {
      if (this.isWritableDir(dir)) return dir
    }
    throw validationError('没有可写的技能目录（检查 SKILLS_DIRS 权限）')
  }

  private readLocalDefinitions(): McpServerDefinition[] {
    const file = this.options.mcpConfigPath
    if (!fs.existsSync(file)) return []
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers?: unknown }
      const parsed = mcpServerDefinitionSchema.array().safeParse(Array.isArray(raw.servers) ? raw.servers : [])
      if (!parsed.success) {
        throw validationError('MCP 配置文件格式不合法', {
          issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        })
      }
      return parsed.data
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw validationError(`MCP 配置文件无法解析: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 原始条目（不做 schema 默认值填充，写回时不污染未修改的条目）。 */
  private readRawServers(): unknown[] {
    const file = this.options.mcpConfigPath
    if (!fs.existsSync(file)) return []
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { servers?: unknown }
    return Array.isArray(raw.servers) ? [...raw.servers] : []
  }

  private writeRawServers(servers: readonly unknown[]): void {
    const file = this.options.mcpConfigPath
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify({ servers }, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  }

}
