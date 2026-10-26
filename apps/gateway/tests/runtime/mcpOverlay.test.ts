import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { afterAll, describe, expect, it } from 'vitest'
import type { McpServerDefinition } from '@agent-studio/shared'
import { mcpServerDefinitionSchema } from '@agent-studio/shared'
import { silentLogger } from '../../src/logger.js'
import { McpConfig, resolvePlaceholders } from '../../src/mcp/McpConfig.js'
import { renderMcpPatch } from '../../src/runtime/SnapshotMaterializer.js'
import { makeTempDir } from '../helpers.js'

const scratch: string[] = []

function fixture(servers: unknown[]): {
  mcp: McpConfig
  configPath: string
  workspace: string
  repoRoot: string
} {
  const root = makeTempDir('mcp')
  scratch.push(root)
  const configPath = path.join(root, 'config', 'mcp-servers.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify({ servers }, null, 2), 'utf8')
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace, { recursive: true })
  const mcp = new McpConfig({
    configPath,
    logger: silentLogger,
    repoRoot: 'E:/Code/OceansLabWeb/dsh_oceanslab',
    env: { DATA_CENTER_TOKEN: 'secret-token', GIS_SERVICE_TOKEN: 'gis-token' },
  })
  return { mcp, configPath, workspace, repoRoot: root }
}

function definition(partial: Record<string, unknown>): McpServerDefinition {
  return mcpServerDefinitionSchema.parse(partial)
}

const STDIO = {
  id: 'data-center',
  name: '数据中心',
  description: '查询数据集目录',
  transport: 'stdio',
  command: 'node',
  args: ['${REPO_ROOT}/scripts/mcp-data-center-server.mjs'],
  env: { DATA_CENTER_TOKEN: '${DATA_CENTER_TOKEN}' },
  toolCallTimeoutMs: 30_000,
  failOnStartup: true,
  enabled: true,
}

const HTTP = {
  id: 'gis-service',
  name: 'GIS 服务',
  transport: 'streamable-http',
  url: 'http://127.0.0.1:9100/mcp',
  headers: { Authorization: 'Bearer ${GIS_SERVICE_TOKEN}' },
  enabled: true,
}

interface PatchEntry {
  insert: Array<{ id: string; name: string; config: Record<string, unknown> }>
}

function parsePatch(yaml: string): PatchEntry[] {
  return YAML.parse(yaml) as PatchEntry[]
}

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true })
})

describe('runtime/mcpOverlay', () => {
  it('stdio：渲染 transport/serverName/command/args/env/cwd/toolCallTimeoutMs/failOnStartupError', () => {
    const { mcp, workspace } = fixture([STDIO])
    const resolved = mcp.resolve(mcp.assertKnown(['data-center'])[0] as McpServerDefinition)
    const parsed = parsePatch(renderMcpPatch([resolved], workspace))

    expect(parsed).toHaveLength(1)
    const entry = parsed[0]?.insert[0]
    expect(entry?.id).toBe('mcp-client-data-center')
    expect(entry?.name).toBe('@deepseek-ai/dsh-mcp-client')
    expect(entry?.config).toMatchObject({
      transport: 'stdio',
      serverName: 'data-center',
      command: 'node',
      toolCallTimeoutMs: 30_000,
      failOnStartupError: true,
      // ${REPO_ROOT} 始终可用，${DATA_CENTER_TOKEN} 从服务环境解析。
      args: ['E:/Code/OceansLabWeb/dsh_oceanslab/scripts/mcp-data-center-server.mjs'],
      env: { DATA_CENTER_TOKEN: 'secret-token' },
    })
    expect(entry?.config.cwd).toBe(workspace.replaceAll('\\', '/'))
  })

  it('streamable-http：渲染 url + 解析后的 headers，不带 cwd/env', () => {
    const { mcp, workspace } = fixture([HTTP])
    const resolved = mcp.resolve(mcp.assertKnown(['gis-service'])[0] as McpServerDefinition)
    const entry = parsePatch(renderMcpPatch([resolved], workspace))[0]?.insert[0]

    expect(entry?.config).toMatchObject({
      transport: 'streamable-http',
      serverName: 'gis-service',
      url: 'http://127.0.0.1:9100/mcp',
      headers: { Authorization: 'Bearer gis-token' },
    })
    expect(entry?.config.cwd).toBeUndefined()
  })

  it('${ENV} 解析不到时报错，绝不写空值', () => {
    const { mcp } = fixture([{ ...STDIO, env: { DATA_CENTER_TOKEN: '${MISSING_TOKEN}' } }])
    const resolved = mcp.assertKnown(['data-center'])[0] as McpServerDefinition
    expect(() => mcp.resolve(resolved)).toThrow(/MISSING_TOKEN/)
  })

  it('未知 / 未启用的服务器抛 MCP_UNKNOWN，并附带可用项', () => {
    const { mcp } = fixture([STDIO, { ...HTTP, enabled: false }])

    let error: unknown
    try {
      mcp.assertKnown(['nope', 'gis-service'])
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({ code: 'MCP_UNKNOWN' })
    expect((error as { details?: { unknown?: string[]; available?: string[] } }).details).toMatchObject({
      unknown: ['nope', 'gis-service'],
      available: ['data-center'],
    })
  })

  it('没有选中服务器时写顶层空数组（YAML 解析为 []，不是 undefined）', () => {
    const { workspace } = fixture([])
    const parsed = parsePatch(renderMcpPatch([], workspace))
    expect(parsed).toEqual([])
  })

  it('resolvePlaceholders：REPO_ROOT 优先于同名环境变量，未知变量报错', () => {
    expect(
      resolvePlaceholders('${REPO_ROOT}/a', {
        env: { REPO_ROOT: '/from-env' },
        available: { REPO_ROOT: '/repo' },
        what: 'test',
      }),
    ).toBe('/repo/a')
    expect(() => resolvePlaceholders('${NOPE}', { env: {}, what: 'test' })).toThrow(/NOPE/)
  })

  it('definitions/summaries 读文件；文件缺失时返回空清单而不报错', () => {
    const { mcp } = fixture([STDIO])
    expect(mcp.summaries()).toEqual([
      {
        id: 'data-center',
        name: '数据中心',
        description: '查询数据集目录',
        transport: 'stdio',
        enabled: true,
      },
    ])

    const root = makeTempDir('mcp-missing')
    scratch.push(root)
    const missing = new McpConfig({
      configPath: path.join(root, 'missing.json'),
      logger: silentLogger,
      repoRoot: root,
      env: {},
    })
    expect(missing.summaries()).toEqual([])
    expect(missing.assertKnown([])).toEqual([])
  })

  it('definition() 校验 id 只允许字母数字 - _', () => {
    expect(() => definition({ ...STDIO, id: 'bad id!' })).toThrow()
    // 默认值：transport=stdio / args=[] / enabled=true / toolCallTimeoutMs=30000
    const minimal = definition({ id: 'x', name: 'X' })
    expect(minimal).toMatchObject({
      transport: 'stdio',
      args: [],
      enabled: true,
      failOnStartup: false,
      toolCallTimeoutMs: 30_000,
    })
  })
})
