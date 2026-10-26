/**
 * 技能目录发现（docs/SERVICE.md §3.3）。
 *
 * 支持两种形态：
 * - **目录 bundle**：`<root>/<skill>/SKILL.md`（YAML frontmatter + Markdown 正文）；
 * - **单文件**：`<root>/<skill>.md`。
 *
 * 规则：
 * - 只认 `.md`；frontmatter 必须是 `---` 包裹的 YAML mapping；
 * - `description` 必填（空描述对配置界面没有意义），`name` 缺省用目录名/文件名；
 * - 同名技能按根目录**优先级**取第一个（靠前的根目录 = 更具体），靠后的忽略；
 * - 按文件 mtime + size 缓存解析结果，避免每个请求都重新解析 YAML。
 */
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import type { SkillSummaryDto } from '@agent-studio/shared'
import type { Logger } from '../logger.js'

export interface SkillRoot {
  path: string
  source: SkillSummaryDto['source']
}

interface CacheEntry {
  mtimeMs: number
  size: number
  value: SkillSummaryDto | undefined
}

export interface ParsedSkillDoc {
  data: Record<string, unknown>
  body: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * 解析 SKILL.md：返回 frontmatter 数据与正文。
 * 没有 frontmatter / YAML 不是 mapping / 解析失败 → undefined。
 */
export function parseSkillDoc(raw: string): ParsedSkillDoc | undefined {
  const match = FRONTMATTER.exec(raw)
  if (match === null) return undefined
  let data: unknown
  try {
    data = YAML.parse(match[1] ?? '')
  } catch {
    return undefined
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  return { data: data as Record<string, unknown>, body: raw.slice(match[0].length) }
}

/** frontmatter → SkillSummaryDto；缺 description 视为非法。 */
export function toSkillSummary(
  filePath: string,
  fallbackName: string,
  source: SkillSummaryDto['source'],
): SkillSummaryDto | undefined {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
  const doc = parseSkillDoc(raw)
  if (doc === undefined) return undefined

  const description = typeof doc.data.description === 'string' ? doc.data.description.trim() : ''
  if (description === '') return undefined
  const name = typeof doc.data.name === 'string' && doc.data.name.trim() !== '' ? doc.data.name.trim() : fallbackName
  const whenToUse = typeof doc.data.whenToUse === 'string' && doc.data.whenToUse.trim() !== '' ? doc.data.whenToUse.trim() : undefined

  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    source,
    path: filePath,
  }
}

/** 技能定义所在的文件（目录 bundle 的 SKILL.md 或单文件），找不到返回 undefined。 */
export function skillDocPath(entryPath: string): string | undefined {
  try {
    const stat = fs.statSync(entryPath)
    if (stat.isDirectory()) {
      const candidate = path.join(entryPath, 'SKILL.md')
      return fs.existsSync(candidate) ? candidate : undefined
    }
    if (stat.isFile() && entryPath.toLowerCase().endsWith('.md')) return entryPath
    return undefined
  } catch {
    return undefined
  }
}

export class SkillCatalog {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(
    private readonly options: {
      roots: SkillRoot[]
      logger: Logger
    },
  ) {}

  roots(): Array<{ path: string; source: SkillSummaryDto['source'] }> {
    return this.options.roots.map((root) => ({ path: root.path, source: root.source }))
  }

  private parseCached(filePath: string, fallbackName: string, source: SkillSummaryDto['source']): SkillSummaryDto | undefined {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return undefined
    }
    const cached = this.cache.get(filePath)
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value
    const value = toSkillSummary(filePath, fallbackName, source)
    if (value === undefined) {
      this.options.logger.warn('skill: skipping invalid definition', { path: filePath })
    }
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
    return value
  }

  /** 全量扫描（按根目录优先级去重）。 */
  list(): SkillSummaryDto[] {
    const byName = new Map<string, SkillSummaryDto>()
    for (const root of this.options.roots) {
      if (!fs.existsSync(root.path)) {
        this.options.logger.debug('skill: root not found', { root: root.path })
        continue
      }
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(root.path, { withFileTypes: true })
      } catch (error) {
        this.options.logger.warn('skill: cannot read root', { root: root.path, error })
        continue
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const entryPath = path.join(root.path, entry.name)
        const docPath = skillDocPath(entryPath)
        if (docPath === undefined) continue
        const fallbackName = entry.isDirectory() ? entry.name : entry.name.replace(/\.md$/i, '')
        const summary = this.parseCached(docPath, fallbackName, root.source)
        if (summary === undefined) continue
        if (byName.has(summary.name)) {
          this.options.logger.debug('skill: duplicate name ignored', {
            name: summary.name,
            keep: byName.get(summary.name)?.path,
            ignored: summary.path,
          })
          continue
        }
        byName.set(summary.name, summary)
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): SkillSummaryDto | undefined {
    return this.list().find((skill) => skill.name === name)
  }

  /** 清空 mtime 缓存（测试/排障用）。 */
  invalidate(): void {
    this.cache.clear()
  }
}
