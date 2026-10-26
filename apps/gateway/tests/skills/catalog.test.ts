import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { silentLogger } from '../../src/logger.js'
import { SkillCatalog, parseSkillDoc } from '../../src/skills/Catalog.js'
import { makeTempDir, writeSkill } from '../helpers.js'

const scratch: string[] = []

function tempRoot(): string {
  const dir = makeTempDir('catalog')
  scratch.push(dir)
  return dir
}

function catalogFor(roots: Array<{ path: string; source: 'project' | 'custom' }>): SkillCatalog {
  return new SkillCatalog({ roots, logger: silentLogger })
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

describe('skills/Catalog', () => {
  it('解析目录 bundle 的 SKILL.md（name / description / whenToUse / source / path）', () => {
    const root = path.join(tempRoot(), 'skills')
    const file = writeSkill(root, {
      name: 'netcdf-analysis',
      description: '分析 NetCDF 文件中的海洋数值模拟结果',
      whenToUse: '需要读取 .nc 文件时',
      bundle: true,
    })

    const skills = catalogFor([{ path: root, source: 'project' }]).list()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      name: 'netcdf-analysis',
      description: '分析 NetCDF 文件中的海洋数值模拟结果',
      whenToUse: '需要读取 .nc 文件时',
      source: 'project',
      path: file,
    })
  })

  it('解析单文件技能，缺省 name 取文件名', () => {
    const root = path.join(tempRoot(), 'skills')
    writeSkill(root, { name: 'gis-processing', description: '处理 GIS 图层', bundle: false })
    // 文件名与 frontmatter 的 name 不一致时以 frontmatter 为准。
    fs.writeFileSync(path.join(root, 'renamed.md'), '---\ndescription: 只有描述\n---\n正文\n', 'utf8')

    const skills = catalogFor([{ path: root, source: 'custom' }]).list()
    expect(skills.map((skill) => skill.name)).toEqual(['gis-processing', 'renamed'])
    expect(skills[1]).toMatchObject({ source: 'custom', description: '只有描述' })
  })

  it('跳过非法 frontmatter：坏 YAML / 缺 description / 没有 frontmatter', () => {
    const root = path.join(tempRoot(), 'skills')
    writeSkill(root, { name: 'broken-yaml', description: 'x', raw: '---\nname: [unclosed\n---\n正文\n' })
    writeSkill(root, { name: 'no-description', description: 'x', raw: '---\nname: no-description\n---\n正文\n' })
    writeSkill(root, { name: 'no-frontmatter', description: 'x', raw: '# 只是 Markdown\n' })
    writeSkill(root, { name: 'good', description: '合法技能' })

    const skills = catalogFor([{ path: root, source: 'project' }]).list()
    expect(skills.map((skill) => skill.name)).toEqual(['good'])
    // 直接测解析函数：没有 frontmatter 返回 undefined。
    expect(parseSkillDoc('# plain')).toBeUndefined()
  })

  it('重名技能按根目录优先级取靠前者，靠后的被忽略', () => {
    const projectRoot = path.join(tempRoot(), 'project-skills')
    const customRoot = path.join(tempRoot(), 'custom-skills')
    writeSkill(projectRoot, { name: 'shared-skill', description: '项目内定义', bundle: true })
    writeSkill(customRoot, { name: 'shared-skill', description: '自定义定义', bundle: true })

    const skills = catalogFor([
      { path: projectRoot, source: 'project' },
      { path: customRoot, source: 'custom' },
    ]).list()
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'shared-skill', description: '项目内定义', source: 'project' })
  })

  it('缺失的技能根目录不报错，roots() 仍原样列出扫描位置', () => {
    const missing = path.join(tempRoot(), 'does-not-exist')
    const present = path.join(tempRoot(), 'skills')
    writeSkill(present, { name: 'ok', description: '可用' })

    const catalog = catalogFor([
      { path: missing, source: 'project' },
      { path: present, source: 'custom' },
    ])
    expect(catalog.list().map((skill) => skill.name)).toEqual(['ok'])
    expect(catalog.roots()).toEqual([
      { path: missing, source: 'project' },
      { path: present, source: 'custom' },
    ])
  })

  it('按 mtime 缓存：文件改动后重新解析', async () => {
    const root = path.join(tempRoot(), 'skills')
    const file = writeSkill(root, { name: 'cached', description: '第一版' })
    const catalog = catalogFor([{ path: root, source: 'project' }])
    expect(catalog.list()[0]?.description).toBe('第一版')

    fs.writeFileSync(file, '---\nname: cached\ndescription: 第二版\n---\n正文\n', 'utf8')
    await new Promise((resolve) => setTimeout(resolve, 10))
    // 显式推进 mtime，避免文件系统时间精度导致缓存未失效。
    const future = new Date(Date.now() + 1000)
    fs.utimesSync(file, future, future)
    expect(catalog.list()[0]?.description).toBe('第二版')
  })
})
