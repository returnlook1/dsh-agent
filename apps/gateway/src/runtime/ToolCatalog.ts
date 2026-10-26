/**
 * 工具目录：业务工具（plugins/agent-tools 构建产物 catalog.json）+ DSH 内置 +
 * MCP 服务器（通配项与已发现工具）。
 *
 * 目录只描述"存在什么工具"，不构成授权；授权永远来自策略快照。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  RESTRICTED_BLOCKED_CAPABILITIES,
  toolCatalogSchema,
  type ToolCatalogEntry,
  type ToolDescriptor,
  type ToolRisk,
} from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import type { McpServersRepository } from '../repositories/mcp.js'

/** MCP serverName 约束：`[A-Za-z0-9_-]{1,32}`（决定模型可见工具名前缀）。 */
export function mcpServerName(serverId: string): string {
  const cleaned = serverId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32)
  return cleaned.length > 0 ? cleaned : 'mcp-server'
}

/** MCP 工具统一命名：`mcp__<serverName>__<toolName>`，尾部通配允许 `*`。 */
export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${mcpServerName(serverId)}__${toolName}`
}

/** DSH 内置工具（第一版受限 Profile 全部移除；目录里保留用于展示与校验）。 */
const DSH_BUILTIN_TOOLS: readonly ToolCatalogEntry[] = [
  {
    name: 'bash',
    title: 'Bash',
    description: '执行任意 shell 命令（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'critical',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'pwsh',
    title: 'PowerShell',
    description: '执行任意 PowerShell 命令（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'critical',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'read_file',
    title: 'Read file',
    description: '读取文件系统（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'high',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'write_file',
    title: 'Write file',
    description: '写入文件系统（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'critical',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'edit_file',
    title: 'Edit file',
    description: '修改文件系统（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'critical',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'fs_search',
    title: 'Search files',
    description: '文件检索（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'high',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'web_search',
    title: 'Web search',
    description: '出网检索（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'high',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'web_fetch',
    title: 'Web fetch',
    description: '抓取任意 URL（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'high',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'subagent',
    title: 'Subagent',
    description: '派生子智能体（第一版禁用）',
    source: 'dsh',
    risk: 'critical',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'skill',
    title: 'Skill',
    description: '加载 Skill（受限 Profile 未挂载）',
    source: 'dsh',
    risk: 'medium',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'todo_write',
    title: 'Todo',
    description: '维护任务清单（受限 Profile 已移除）',
    source: 'dsh',
    risk: 'low',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
  {
    name: 'ask_user_question',
    title: 'Ask user',
    description: '向用户提问（SDK Profile 下无答者）',
    source: 'dsh',
    risk: 'low',
    restrictedAllowed: false,
    requiresApprovalChannel: false,
  },
]

export interface ToolCatalogOptions {
  /** 业务工具目录文件；缺省从插件同目录的 catalog.json 查找。 */
  catalogPath?: string
  /** 业务工具插件入口（config.pluginTools），用于推导 catalog.json 位置。 */
  pluginToolsPath?: string
  mcpServers: McpServersRepository
  logger: Logger
}

export class ToolCatalog {
  private businessCache: { mtimeMs: number; entries: ToolCatalogEntry[] } | undefined
  private readonly discovered = new Map<string, ToolCatalogEntry[]>()

  constructor(private readonly options: ToolCatalogOptions) {}

  /** 候选目录路径：显式配置 → dist/catalog.json → 插件包根 catalog.json。 */
  private resolveCatalogPath(): string | undefined {
    const explicit = this.options.catalogPath
    if (explicit !== undefined && fs.existsSync(explicit)) return explicit
    const pluginTools = this.options.pluginToolsPath ?? process.env.AGENT_STUDIO_PLUGIN_TOOLS
    const bases: string[] = []
    if (pluginTools !== undefined && pluginTools.trim() !== '') {
      const dir = path.dirname(path.resolve(pluginTools))
      bases.push(path.join(dir, 'catalog.json'), path.join(dir, '..', 'catalog.json'))
    }
    for (const candidate of bases) {
      if (fs.existsSync(candidate)) return candidate
    }
    return undefined
  }

  /** 读取业务工具目录；文件缺失返回空数组（业务工具尚未构建时网关仍可启动）。 */
  businessEntries(): ToolCatalogEntry[] {
    const catalogPath = this.resolveCatalogPath()
    if (catalogPath === undefined) return []
    try {
      const stat = fs.statSync(catalogPath)
      if (this.businessCache !== undefined && this.businessCache.mtimeMs === stat.mtimeMs) {
        return this.businessCache.entries
      }
      const parsed = toolCatalogSchema.safeParse(JSON.parse(fs.readFileSync(catalogPath, 'utf8')))
      if (!parsed.success) {
        this.options.logger.error('tool catalog failed validation', {
          catalogPath,
          issues: parsed.error.issues,
        })
        return []
      }
      this.businessCache = { mtimeMs: stat.mtimeMs, entries: parsed.data.entries }
      return parsed.data.entries
    } catch (error) {
      this.options.logger.warn('failed to load tool catalog', { catalogPath, error })
      return []
    }
  }

  /** MCP：已启用的服务器各给一个通配工具 + 已探测到的具体工具。 */
  mcpEntries(): ToolCatalogEntry[] {
    const entries: ToolCatalogEntry[] = []
    for (const server of this.options.mcpServers.listEnabled()) {
      entries.push({
        name: mcpToolName(server.id, '*'),
        title: `${server.name} (全部工具)`,
        description: `MCP 服务器 ${server.id} 的全部工具；实际挂载受 security.networkAccess 限制`,
        source: 'mcp',
        mcpServer: server.id,
        risk: 'medium',
        restrictedAllowed: true,
        // 工具调用经过策略插件，具备文件审批通道。
        requiresApprovalChannel: true,
      })
      for (const tool of this.discovered.get(server.id) ?? []) entries.push(tool)
    }
    return entries
  }

  /** McpProbe 结果缓存（仅进程内，避免每次列目录都启动子进程）。 */
  rememberDiscoveredTools(serverId: string, tools: Array<{ name: string; description?: string }>): void {
    this.discovered.set(
      serverId,
      tools.map((tool) => ({
        name: mcpToolName(serverId, tool.name),
        title: tool.name,
        description: tool.description ?? '',
        source: 'mcp' as const,
        mcpServer: serverId,
        risk: 'medium' as const,
        restrictedAllowed: true,
        requiresApprovalChannel: true,
      })),
    )
  }

  all(): ToolCatalogEntry[] {
    return [...this.businessEntries(), ...this.mcpEntries(), ...DSH_BUILTIN_TOOLS]
  }

  find(name: string): ToolCatalogEntry | undefined {
    return this.all().find((entry) => entry.name === name)
  }

  /** 是否是已知工具（精确名或 MCP 通配）。 */
  isKnown(name: string): boolean {
    return this.find(name) !== undefined
  }

  /** 是否具备审批通道（ask 只允许用于这里的工具）。 */
  supportsApprovalChannel(name: string): boolean {
    const entry = this.find(name)
    if (entry !== undefined) return entry.requiresApprovalChannel === true
    // 未在目录中的 MCP 名字：只要服务器前缀被识别，就认为经过策略插件。
    return /^mcp__[a-z0-9][a-z0-9-_]*__/.test(name)
  }

  riskFor(name: string): ToolRisk | undefined {
    const exact = this.find(name)
    if (exact !== undefined) return exact.risk
    if (name.startsWith('mcp__')) return 'medium'
    return undefined
  }

  /** 受限运行时被显式移除的能力列表（管理端提示用）。 */
  blockedCapabilities(): string[] {
    return RESTRICTED_BLOCKED_CAPABILITIES.map((entry) => entry.capability)
  }

  descriptors(): ToolDescriptor[] {
    return this.all().map((entry) => {
      const descriptor: ToolDescriptor = {
        name: entry.name,
        source: entry.source,
        title: entry.title,
        description: entry.description,
        risk: entry.risk,
      }
      if (entry.mcpServer !== undefined) descriptor.mcpServer = entry.mcpServer
      if (entry.requiresApprovalChannel !== undefined) {
        descriptor.requiresApprovalChannel = entry.requiresApprovalChannel
      }
      return descriptor
    })
  }
}
