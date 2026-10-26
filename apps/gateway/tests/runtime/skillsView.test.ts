import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { AgentConfig, AgentConfigSnapshot } from '@agent-studio/shared'
import { silentLogger } from '../../src/logger.js'
import { McpConfig } from '../../src/mcp/McpConfig.js'
import { computeConfigKey } from '../../src/runtime/ConfigKey.js'
import { SnapshotMaterializer } from '../../src/runtime/SnapshotMaterializer.js'
import { SkillCatalog } from '../../src/skills/Catalog.js'
import { SkillSource } from '../../src/skills/SkillSource.js'
import { createTestConfig, makeTempDir, writeSkill, writeTemplate } from '../helpers.js'

const scratch: string[] = []

interface Fixture {
  root: string
  skills: SkillSource
  materializer: SnapshotMaterializer
  skillsDir: string
}

function createFixture(): Fixture {
  const root = makeTempDir('skillsview')
  scratch.push(root)
  const skillsDir = path.join(root, 'skills')
  writeSkill(skillsDir, {
    name: 'netcdf-analysis',
    description: '分析 NetCDF 文件中的海洋数值模拟结果',
    whenToUse: '需要读取 .nc 文件时',
    bundle: true,
  })
  writeSkill(skillsDir, { name: 'gis-processing', description: '处理 GIS 图层', bundle: false })

  const mcpConfigPath = path.join(root, 'config', 'mcp-servers.json')
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true })
  fs.writeFileSync(mcpConfigPath, JSON.stringify({ servers: [] }), 'utf8')
  const templateDir = path.join(root, 'templates')
  writeTemplate(templateDir)

  const config = createTestConfig({ root, skillsDir, mcpConfigPath, templateDir })
  const catalog = new SkillCatalog({ roots: [{ path: skillsDir, source: 'project' }], logger: silentLogger })
  const skills = new SkillSource(catalog, silentLogger)
  const mcp = new McpConfig({ configPath: mcpConfigPath, logger: silentLogger, repoRoot: root, env: {} })
  const materializer = new SnapshotMaterializer({ config, logger: silentLogger, skills, mcp })
  return { root, skills, materializer, skillsDir }
}

function makeSnapshot(config: Partial<AgentConfig> = {}, overrides: Partial<AgentConfigSnapshot> = {}): AgentConfigSnapshot {
  const merged: AgentConfig = {
    skills: [],
    mcpServers: [],
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    systemPrompt: '',
    ...config,
  }
  return {
    ...merged,
    configKey: computeConfigKey(merged),
    capabilityRevision: 'test',
    projectId: 'project-1',
    createdAt: Date.now(),
    inheritedFromProject: true,
    ...overrides,
  }
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

describe('runtime/skillsView（硬过滤）', () => {
  it('skills-view 只包含被选中的技能副本（目录 bundle + 单文件）', () => {
    const { materializer } = createFixture()
    const materialized = materializer.materialize(makeSnapshot({ skills: ['netcdf-analysis'] }))

    const entries = fs.readdirSync(materialized.skillsViewDir).sort()
    expect(entries).toEqual(['netcdf-analysis'])
    expect(fs.existsSync(path.join(materialized.skillsViewDir, 'netcdf-analysis', 'SKILL.md'))).toBe(true)

    // 换一个选择：旧的副本被清掉，只留新选的。
    const second = materializer.materialize(
      makeSnapshot({ skills: ['gis-processing'] }, { configKey: 'second-key' }),
    )
    expect(fs.readdirSync(second.skillsViewDir).sort()).toEqual(['gis-processing.md'])
  })

  it('选择目录 bundle + 单文件两种技能时都复制正确', () => {
    const { materializer } = createFixture()
    const materialized = materializer.materialize(
      makeSnapshot({ skills: ['netcdf-analysis', 'gis-processing'] }),
    )
    expect(fs.readdirSync(materialized.skillsViewDir).sort()).toEqual(['gis-processing.md', 'netcdf-analysis'])
  })

  it('未知技能抛 SKILL_UNKNOWN，并附带可用项', () => {
    const { materializer } = createFixture()
    let error: unknown
    try {
      materializer.materialize(makeSnapshot({ skills: ['missing-skill'] }))
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'SKILL_UNKNOWN' })
    expect((error as { details?: { unknown?: string[]; available?: string[] } }).details).toMatchObject({
      unknown: ['missing-skill'],
      available: ['gis-processing', 'netcdf-analysis'],
    })
  })

  it('快照目录布局 + 模板占位符全部替换（无 {{...}} 残留）', () => {
    const { materializer } = createFixture()
    const materialized = materializer.materialize(makeSnapshot({ skills: ['netcdf-analysis'] }))

    expect(materialized.rootDir.endsWith(path.join('snapshots', materialized.configKey))).toBe(true)
    for (const dir of [materialized.homeDir, materialized.skillsViewDir, materialized.workspaceDir, materialized.patchDir]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true)
    }
    expect(fs.existsSync(materialized.profilePatchPath)).toBe(true)
    expect(fs.existsSync(materialized.agentPatchPath)).toBe(true)
    expect(fs.existsSync(materialized.mcpPatchPath)).toBe(true)
    expect(fs.readFileSync(path.join(materialized.homeDir, 'cordis.patch.yml'), 'utf8').trim()).toBe('[]')

    const profilePatch = fs.readFileSync(materialized.profilePatchPath, 'utf8')
    expect(profilePatch).not.toContain('{{')
    expect(profilePatch).toContain(materialized.skillsViewDir.replaceAll('\\', '/'))
    expect(profilePatch).toContain(materialized.workspaceDir.replaceAll('\\', '/'))
    expect(profilePatch).toContain('includeDefaultRoots: false')

    const pkg = JSON.parse(fs.readFileSync(path.join(materialized.profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(pkg.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-sdk-minimal'])
  })

  it('空系统提示词 → agent patch 为 []，env 给中性默认人设', () => {
    const { materializer } = createFixture()
    const materialized = materializer.materialize(makeSnapshot())
    expect(fs.readFileSync(materialized.agentPatchPath, 'utf8')).toContain('[]')
    expect(materialized.env.AGENT_SERVICE_SYSTEM_PROMPT).toContain('helpful assistant')
    // 没选中 MCP → 顶层空数组（parsePatchList 要求数组）。
    expect(fs.readFileSync(materialized.mcpPatchPath, 'utf8')).toContain('[]')
  })

  it('配置系统提示词 → agent patch 写入 personaPrefix（config 整块替换）', () => {
    const { materializer } = createFixture()
    const prompt = '你是海洋环境分析助手。\n只能使用已授权的技能。'
    const materialized = materializer.materialize(makeSnapshot({ systemPrompt: prompt }))
    const patch = fs.readFileSync(materialized.agentPatchPath, 'utf8')
    expect(patch).toContain('- id: system-prompt')
    expect(patch).toContain('includeHarnessIdentity: false')
    expect(patch).toContain('includeRuntimeContext: false')
    expect(patch).toContain('personaPrefix:')
    expect(materialized.env.AGENT_SERVICE_SYSTEM_PROMPT).toBe(prompt)
    expect(materialized.env.AGENT_STUDIO_SYSTEM_PROMPT).toBeUndefined()
  })

  it('子进程环境从零构造：隔离 home、业务工具变量、不继承宿主 DSH_PROFILE', () => {
    const { materializer } = createFixture()
    process.env.DSH_PROFILE = 'desktop-should-not-leak'
    process.env.HTTP_PROXY = 'http://proxy-should-not-leak:8080'
    try {
      const materialized = materializer.materialize(makeSnapshot())
      expect(materialized.env.DSH_HOME).toBe(materialized.homeDir)
      expect(materialized.env.DSH_AGENTS_HOME).toBe(path.join(materialized.homeDir, 'agents'))
      expect(materialized.env.DSH_TELEMETRY_DISABLED).toBe('1')
      expect(materialized.env.DSH_PROFILE).toBeUndefined()
      expect(materialized.env.HTTP_PROXY).toBeUndefined()
      expect(materialized.env.AGENT_STUDIO_TOOLS_DATA_DIR).toBe(
        path.join(materialized.workspaceDir, '.studio', 'data'),
      )
      expect(materialized.env.AGENT_STUDIO_OUTPUT_DIR).toBe(
        path.join(materialized.workspaceDir, '.studio', 'output'),
      )
      expect(materialized.env.DEEPSEEK_API_KEY).toBe('unit-test-key')
    } finally {
      delete process.env.DSH_PROFILE
      delete process.env.HTTP_PROXY
    }
  })

  it('不同 configKey → 不同快照目录；同 configKey 复用同一目录', () => {
    const { materializer } = createFixture()
    const first = materializer.materialize(makeSnapshot({ skills: ['netcdf-analysis'] }))
    const again = materializer.materialize(makeSnapshot({ skills: ['netcdf-analysis'] }))
    const other = materializer.materialize(makeSnapshot({ skills: ['gis-processing'] }))

    expect(again.rootDir).toBe(first.rootDir)
    expect(other.rootDir).not.toBe(first.rootDir)
  })

  it('技能内容变化后 skills-view 重建（mtime 指纹）', async () => {
    const { materializer, skillsDir } = createFixture()
    const snapshot = makeSnapshot({ skills: ['netcdf-analysis'] })
    const materialized = materializer.materialize(snapshot)
    const skillFile = path.join(materialized.skillsViewDir, 'netcdf-analysis', 'SKILL.md')
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('正文：按步骤操作。')

    const future = new Date(Date.now() + 5_000)
    fs.writeFileSync(
      path.join(skillsDir, 'netcdf-analysis', 'SKILL.md'),
      '---\nname: netcdf-analysis\ndescription: 新版本\n---\n新正文\n',
      'utf8',
    )
    fs.utimesSync(path.join(skillsDir, 'netcdf-analysis', 'SKILL.md'), future, future)
    await new Promise((resolve) => setTimeout(resolve, 10))

    materializer.materialize(snapshot)
    expect(fs.readFileSync(skillFile, 'utf8')).toContain('新正文')
  })
})
