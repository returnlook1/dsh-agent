/**
 * 能力版本（capabilityRevision）回归测试（review P1-5）。
 *
 * 断言：技能内容 / MCP 定义 / profile 模板变化时，新对话的 configKey 必须变化；
 * 只是顺序不同则必须相同。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { silentLogger } from '../../src/logger.js'
import { McpConfig } from '../../src/mcp/McpConfig.js'
import { CapabilityRevision } from '../../src/runtime/CapabilityRevision.js'
import { computeConfigKey } from '../../src/runtime/ConfigKey.js'
import { SkillCatalog } from '../../src/skills/Catalog.js'
import { SkillSource } from '../../src/skills/SkillSource.js'
import { makeTempDir, writeSkill } from '../helpers.js'

interface Fixture {
  skillsDir: string
  templateDir: string
  mcpConfigPath: string
  revision: CapabilityRevision
}

function createFixture(): Fixture {
  const root = makeTempDir('revision-')
  const skillsDir = path.join(root, 'skills')
  const templateDir = path.join(root, 'templates')
  const mcpConfigPath = path.join(root, 'config', 'mcp-servers.json')
  fs.mkdirSync(templateDir, { recursive: true })
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true })
  fs.writeFileSync(path.join(templateDir, 'package.json'), '{"dsh":{"profile":{"bundles":["x"]}}}\n', 'utf8')
  fs.writeFileSync(path.join(templateDir, 'cordis.patch.yml'), '[]\n', 'utf8')
  fs.writeFileSync(
    mcpConfigPath,
    JSON.stringify({
      servers: [
        {
          id: 'data-center',
          name: '数据中心',
          transport: 'stdio',
          command: 'node',
          args: ['server.mjs'],
          toolCallTimeoutMs: 30000,
          enabled: true,
        },
      ],
    }),
    'utf8',
  )
  writeSkill(skillsDir, { name: 'netcdf-analysis', description: '分析 NetCDF', bundle: true })
  writeSkill(skillsDir, { name: 'gis-processing', description: 'GIS 处理', bundle: true })

  const catalog = new SkillCatalog({ roots: [{ path: skillsDir, source: 'project' }], logger: silentLogger })
  const skills = new SkillSource(catalog, silentLogger)
  const mcp = new McpConfig({ configPath: mcpConfigPath, logger: silentLogger, repoRoot: root, env: {} })
  const revision = new CapabilityRevision({ skills, mcp, logger: silentLogger, templateDir })
  return { skillsDir, templateDir, mcpConfigPath, revision }
}

describe('CapabilityRevision', () => {
  it('同样的能力重复计算得到同一个值（顺序无关）', () => {
    const { revision } = createFixture()
    const a = revision.compute(['netcdf-analysis', 'gis-processing'], ['data-center'])
    const b = revision.compute(['gis-processing', 'netcdf-analysis'], ['data-center'])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{12}$/)
  })

  it('修改 SKILL.md 内容（名字不变）→ 版本变化', () => {
    const fixture = createFixture()
    const before = fixture.revision.compute(['netcdf-analysis'], [])
    const file = path.join(fixture.skillsDir, 'netcdf-analysis', 'SKILL.md')
    fs.appendFileSync(file, '\n补充一段新的分析步骤。\n', 'utf8')
    const after = fixture.revision.compute(['netcdf-analysis'], [])
    expect(after).not.toBe(before)
  })

  it('修改 MCP 定义（id 不变）→ 版本变化', () => {
    const fixture = createFixture()
    const before = fixture.revision.compute([], ['data-center'])
    const config = JSON.parse(fs.readFileSync(fixture.mcpConfigPath, 'utf8')) as {
      servers: Array<{ args: string[] }>
    }
    config.servers[0]!.args = ['server-v2.mjs']
    fs.writeFileSync(fixture.mcpConfigPath, JSON.stringify(config), 'utf8')
    const after = fixture.revision.compute([], ['data-center'])
    expect(after).not.toBe(before)
  })

  it('修改 profile 模板 → 版本变化', () => {
    const fixture = createFixture()
    const before = fixture.revision.compute([], [])
    fs.appendFileSync(path.join(fixture.templateDir, 'cordis.patch.yml'), '# tweak\n', 'utf8')
    const after = fixture.revision.compute([], [])
    expect(after).not.toBe(before)
  })

  it('configKey 纳入版本：同名不同内容的新对话得到不同的运行时指纹', () => {
    const { revision } = createFixture()
    const base = {
      skills: ['netcdf-analysis'],
      mcpServers: [],
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      systemPrompt: '',
    }
    const v1 = revision.compute(base.skills, base.mcpServers)
    const key1 = computeConfigKey({ ...base, capabilityRevision: v1 })
    const key2 = computeConfigKey({ ...base, capabilityRevision: 'another-revision' })
    expect(key1).not.toBe(key2)
  })
})
