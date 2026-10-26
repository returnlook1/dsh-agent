/**
 * 既有 DSH 配置复用（review P0-1）：只读导入 Skills / MCP / Provider 定义。
 *
 * 用注入的 dump 文本模拟"源 profile 的组合"，不启动 dsh。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { silentLogger } from '../../src/logger.js'
import {
  DshSource,
  expressionMap,
  normaliseServerId,
  providerCredentialNames,
  readCredentialRefNames,
  readCredentialValues,
} from '../../src/dsh/DshSource.js'
import { makeTempDir } from '../helpers.js'

const DUMP = `
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers: {}
- id: opencode-go
  name: dsh-opencode-go
  config:
    accounts:
      - id: acc-1
        apiKeyEnv: TEST_OPENCODE_ACCOUNT
- id: optional-session-title-all-prompts
  name: '@deepseek-ai/dsh-session-title-all-prompts-llm'
  config:
    targetWords: 5
- id: mcp-client-water
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: stdio
    serverName: water
    command: node
    args: ['./water.mjs']
    env:
      WATER_TOKEN: !!js process.env.WATER_TOKEN ?? ''
    toolCallTimeoutMs: 15000
- id: mcp-client-geo
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    transport: streamable-http
    serverName: geo
    url: 'http://127.0.0.1:9200/mcp'
    headers:
      Authorization: !!js \`Bearer \${process.env.GEO_TOKEN ?? ''}\`
- id: web-app
  name: '@deepseek-ai/dsh-web-app'
`

function createSource(
  options: { home?: string; dump?: string; importProviders?: boolean; importMcp?: boolean } = {},
): DshSource {
  return new DshSource({
    home: options.home ?? 'C:/fake-dsh-home',
    profile: 'desktop',
    dshBin: 'C:/fake/dsh-bin.js',
    workDir: makeTempDir('dsh-import-'),
    logger: silentLogger,
    importProviders: options.importProviders ?? true,
    importMcp: options.importMcp ?? true,
    dumpOverride: () => options.dump ?? DUMP,
  })
}

describe('DshSource', () => {
  it('未配置 home 时完全关闭', () => {
    const source = new DshSource({
      home: undefined,
      profile: 'desktop',
      dshBin: 'x',
      workDir: makeTempDir('dsh-off-'),
      logger: silentLogger,
      importProviders: true,
      importMcp: true,
    })
    expect(source.enabled).toBe(false)
    expect(source.skillRoots()).toEqual([])
    expect(source.mcpDefinitions()).toEqual([])
    expect(source.providerEntries()).toEqual([])
    expect(source.describe()).toMatchObject({ enabled: false })
  })

  it('从源 home 读取技能目录', () => {
    const home = makeTempDir('dsh-home-')
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(home, 'agents', 'skills'), { recursive: true })
    const source = createSource({ home })
    const roots = source.skillRoots().map((root) => root.path)
    expect(roots).toContain(path.join(home, 'skills'))
    expect(roots).toContain(path.join(home, 'agents', 'skills'))
  })

  it('导入 provider 条目：跳过与服务冲突的 id 与非 provider 插件', () => {
    const source = createSource()
    const entries = source.providerEntries()
    const ids = entries.map((entry) => entry.id)
    expect(ids).toContain('llm-pi-ai')
    expect(ids).toContain('opencode-go')
    expect(ids).not.toContain('llm-deepseek')
    expect(ids).not.toContain('optional-session-title-all-prompts')
    expect(ids).not.toContain('web-app')
  })

  it('可以关闭 provider / MCP 导入', () => {
    const noProviders = createSource({ importProviders: false })
    expect(noProviders.providerEntries()).toEqual([])
    const noMcp = createSource({ importMcp: false })
    expect(noMcp.mcpDefinitions()).toEqual([])
  })

  it('导入 MCP 定义：stdio 与 streamable-http，凭据还原为 ${ENV}', () => {
    const source = createSource()
    const servers = source.mcpDefinitions()
    expect(servers.map((server) => server.id)).toEqual(['water', 'geo'])
    const water = servers.find((server) => server.id === 'water')
    expect(water).toMatchObject({ transport: 'stdio', command: 'node', args: ['./water.mjs'] })
    expect(water?.env.WATER_TOKEN).toBe('${WATER_TOKEN}')
    const geo = servers.find((server) => server.id === 'geo')
    expect(geo).toMatchObject({ transport: 'streamable-http', url: 'http://127.0.0.1:9200/mcp' })
    expect(geo?.headers.Authorization).toBe('Bearer ${GEO_TOKEN}')
  })

  it('provider 凭据清单：只报名字与来源', () => {
    const home = makeTempDir('dsh-cred-')
    fs.writeFileSync(
      path.join(home, '.credentials.yaml'),
      ['version: 1', 'refs:', '  TEST_OPENCODE_ACCOUNT: secret-value', '  UNUSED: other'].join('\n'),
      'utf8',
    )
    const source = createSource({ home })
    const status = source.credentialStatus()
    const opencode = status.find((item) => item.name === 'TEST_OPENCODE_ACCOUNT')
    expect(opencode?.availableIn).toBe('dsh-credentials')
    expect(JSON.stringify(status)).not.toContain('secret-value')

    const values = source.providerEnvValues(['TEST_OPENCODE_ACCOUNT'])
    expect(values.TEST_OPENCODE_ACCOUNT).toBe('secret-value')
  })

  it('describe 汇总来源信息（不泄露凭据值）', () => {
    const source = createSource()
    const described = source.describe()
    expect(described.enabled).toBe(true)
    expect(described.label).toBe('C:/fake-dsh-home#desktop')
    expect(described.providers.map((entry) => entry.id)).toContain('opencode-go')
    expect(described.mcpServers).toEqual(['water', 'geo'])
    expect(JSON.stringify(described)).not.toContain('secret')
  })

  it('dump 失败时降级为空并记录错误', () => {
    const source = new DshSource({
      home: 'C:/fake-dsh-home',
      profile: 'desktop',
      dshBin: 'C:/fake/dsh-bin.js',
      workDir: makeTempDir('dsh-bad-'),
      logger: silentLogger,
      importProviders: true,
      importMcp: true,
      dumpOverride: () => 'not: [an array',
    })
    expect(source.providerEntries()).toEqual([])
    expect(source.mcpDefinitions()).toEqual([])
  })
})

describe('DshSource 纯函数', () => {
  it('normaliseServerId 只保留允许字符并限长', () => {
    expect(normaliseServerId('data center/水')).toBe('data-center--')
    expect(normaliseServerId('a'.repeat(50))).toHaveLength(32)
  })

  it('expressionMap 把 process.env 表达式还原成 ${ENV}', () => {
    expect(
      expressionMap({
        A: 'process.env.A ?? \'\'',
        B: 'Bearer ${process.env.B ?? \'\'}',
        C: 'literal-value',
      }),
    ).toEqual({ A: '${A}', B: 'Bearer ${B}', C: 'literal-value' })
  })

  it('providerCredentialNames 只收集 *Env 键里的环境变量名', () => {
    const names = providerCredentialNames([
      { id: 'a', name: 'x', config: { apiKeyEnv: 'TOKEN_A', accounts: [{ apiKeyEnv: 'TOKEN_B' }] } },
      { id: 'b', name: 'y', config: { baseURL: 'http://x' } },
    ])
    expect(names.sort()).toEqual(['TOKEN_A', 'TOKEN_B'])
  })

  it('凭据文件只读键名与字符串值', () => {
    const root = makeTempDir('cred-')
    const file = path.join(root, '.credentials.yaml')
    fs.writeFileSync(file, ['version: 1', 'refs:', '  A: one', '  B:', '    token: x'].join('\n'), 'utf8')
    expect(readCredentialRefNames(file)).toEqual(['A', 'B'])
    expect(readCredentialValues(file)).toEqual({ A: 'one' })
  })
})
