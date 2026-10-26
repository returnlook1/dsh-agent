/**
 * 定位某个技能名的源，并把它复制进运行时快照的 `skills-view/`。
 *
 * 这是"技能过滤是硬的"的落点（docs/SERVICE.md §2 / 硬要求 #4）：
 * 快照物化时清空 skills-view，只复制被选中的技能，模板再以
 * `includeDefaultRoots: false` + `customSkillDirs: [skills-view]` 只读这一个目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { SkillSummaryDto } from '@agent-studio/shared'
import type { Logger } from '../logger.js'
import { ApiError } from '../http/errors.js'
import type { SkillCatalog } from './Catalog.js'

export interface SkillLocation {
  name: string
  /** 目录 bundle（复制整个目录）或单文件（复制成 `<name>.md`）。 */
  kind: 'directory' | 'file'
  /** 源路径：目录 bundle 是目录，单文件是 `.md` 文件。 */
  path: string
  source: SkillSummaryDto['source']
}

export class SkillSource {
  constructor(
    private readonly catalog: SkillCatalog,
    private readonly logger: Logger,
  ) {}

  resolve(name: string): SkillLocation | undefined {
    const summary = this.catalog.get(name)
    if (summary === undefined || summary.path === undefined) return undefined
    try {
      const stat = fs.statSync(summary.path)
      if (stat.isDirectory()) return { name, kind: 'directory', path: summary.path, source: summary.source }
      // 目录 bundle 的发现结果指向 `<skill>/SKILL.md`：复制单位是整个目录。
      if (path.basename(summary.path).toLowerCase() === 'skill.md') {
        return { name, kind: 'directory', path: path.dirname(summary.path), source: summary.source }
      }
      return { name, kind: 'file', path: summary.path, source: summary.source }
    } catch {
      return undefined
    }
  }

  /**
   * 校验一组技能名，全部存在才返回位置；有未知项时抛 `SKILL_UNKNOWN`（附带可用项）。
   */
  locate(names: readonly string[]): SkillLocation[] {
    const locations: SkillLocation[] = []
    const unknown: string[] = []
    for (const name of names) {
      const location = this.resolve(name)
      if (location === undefined) unknown.push(name)
      else locations.push(location)
    }
    if (unknown.length > 0) {
      throw new ApiError('SKILL_UNKNOWN', `未知技能: ${unknown.join(', ')}`, {
        unknown,
        available: this.catalog.list().map((skill) => skill.name),
      })
    }
    return locations
  }

  /**
   * 重建 skills-view：先清空，再只复制给定技能。
   * @returns 实际复制进去的技能（排障/测试用）
   */
  copyInto(names: readonly string[], skillsViewDir: string): SkillLocation[] {
    const locations = this.locate(names)
    fs.rmSync(skillsViewDir, { recursive: true, force: true })
    fs.mkdirSync(skillsViewDir, { recursive: true })

    for (const location of locations) {
      if (location.kind === 'directory') {
        fs.cpSync(location.path, path.join(skillsViewDir, location.name), { recursive: true })
      } else {
        fs.copyFileSync(location.path, path.join(skillsViewDir, `${location.name}.md`))
      }
    }
    this.logger.debug('skills-view materialized', {
      skillsViewDir,
      skills: locations.map((location) => location.name),
    })
    return locations
  }
}
