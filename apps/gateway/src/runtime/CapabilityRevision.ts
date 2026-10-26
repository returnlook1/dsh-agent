/**
 * 能力版本（capabilityRevision）：把"名字没变但内容变了"纳入配置指纹。
 *
 * 组成：
 * - **技能内容**：被选中技能的每个文件内容哈希（目录 bundle 递归），按路径排序；
 * - **MCP 定义**：被选中服务器的**书写态**定义（含 `${ENV}` 引用，不含解析后的值）；
 * - **profile 模板**：`runtime/templates/agent-service/{package.json,cordis.patch.yml}` 内容；
 *   若启用了 DSH bundle 继承，还包含继承来的 bundle 列表。
 *
 * 结果取 sha256 前 12 位；同一组"名字 + 内容"永远得到同一个值。
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Logger } from '../logger.js'
import type { McpConfig } from '../mcp/McpConfig.js'
import { canonicalJson } from './ConfigKey.js'
import type { SkillSource } from '../skills/SkillSource.js'

export interface CapabilityRevisionDeps {
  skills: SkillSource
  mcp: McpConfig
  logger: Logger
  /** profile 模板目录（与 SnapshotMaterializer 一致）。 */
  templateDir: string
  /** 可选：继承自既有 DSH profile 的 bundle 列表（参与版本计算）。 */
  inheritedBundles?: () => readonly string[]
}

/** 递归计算一个文件/目录的内容哈希；文件不存在返回空串。 */
function hashPath(target: string, hash: ReturnType<typeof createHash>): void {
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    hash.update('missing:').update(target).update('\n')
    return
  }
  if (stat.isDirectory()) {
    hash.update(`dir:${target}\n`)
    for (const entry of fs.readdirSync(target, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      hashPath(path.join(target, entry.name), hash)
    }
    return
  }
  hash.update(`file:${target}:${stat.size}\n`)
  try {
    hash.update(fs.readFileSync(target))
  } catch {
    hash.update('unreadable\n')
  }
  hash.update('\n')
}

export class CapabilityRevision {
  private templateCache: { key: string; value: string } | undefined

  constructor(private readonly deps: CapabilityRevisionDeps) {}

  /** profile 模板摘要（按 mtime+size 缓存，模板改动后自动失效）。 */
  private templateDigest(): string {
    const files = ['package.json', 'cordis.patch.yml']
    const stats = files.map((file) => {
      const full = path.join(this.deps.templateDir, file)
      try {
        const stat = fs.statSync(full)
        return `${full}:${stat.mtimeMs}:${stat.size}`
      } catch {
        return `${full}:missing`
      }
    })
    const key = stats.join('|')
    if (this.templateCache?.key === key) return this.templateCache.value
    const hash = createHash('sha256')
    for (const file of files) hashPath(path.join(this.deps.templateDir, file), hash)
    const value = hash.digest('hex').slice(0, 12)
    this.templateCache = { key, value }
    return value
  }

  /**
   * 计算能力版本。
   * @param skills - 被选中的技能名
   * @param mcpServers - 被选中的 MCP 服务器 id
   */
  compute(skills: readonly string[], mcpServers: readonly string[]): string {
    const hash = createHash('sha256')

    // 技能：按名字排序，逐个内容哈希（找不到的按 missing 计入，保证"技能被删"也会变更版本）
    const locations = this.deps.skills.locate([...skills])
    const byName = new Map(locations.map((location) => [location.name, location]))
    for (const name of [...skills].sort()) {
      hash.update(`skill:${name}\n`)
      const location = byName.get(name)
      if (location === undefined) {
        hash.update('missing\n')
        continue
      }
      hashPath(location.path, hash)
    }

    // MCP：书写态定义（不解析 ${ENV}），按 id 排序
    const definitions = this.deps.mcp.definitions()
    const selected = new Map(definitions.map((definition) => [definition.id, definition]))
    const written: unknown[] = []
    for (const id of [...mcpServers].sort()) {
      const definition = selected.get(id)
      written.push(definition ?? { id, missing: true })
    }
    hash.update(canonicalJson(written))
    hash.update('\n')

    // profile 模板（+ 可选的继承 bundle）
    hash.update(`template:${this.templateDigest()}\n`)
    const inherited = this.deps.inheritedBundles?.() ?? []
    if (inherited.length > 0) hash.update(`bundles:${canonicalJson([...inherited].sort())}\n`)

    const revision = hash.digest('hex').slice(0, 12)
    this.deps.logger.debug('capability revision computed', { skills, mcpServers, revision })
    return revision
  }
}
