/**
 * MCP：凭据引用、运行时 patch 渲染与探测目标（review P0-3 的回归测试）。
 *
 * 核心断言：**凭据值永远不出现在生成的 YAML 里**，只有 `!!js process.env.X` 引用；
 * 真实值只在子进程环境 / 探测请求里出现。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { McpServerDefinition } from '@agent-studio/shared'
import { McpConfig, parseValueExpression, resolvePathPlaceholders } from '../../src/mcp/McpConfig.js'
import { renderMcpPatch } from '../../src/runtime/SnapshotMaterializer.js'
import { silentLogger } from '../../src/logger.js'
import { makeTempDir } from '../helpers.js'

const REPO_ROOT = 'E:/repo'

function writeConfig(root: string, servers: unknown[]): string {
  const configPath = path.join(root, 'mcp-servers.json')
  fs.mkdirSync(path.dirname(configPath), { recursive: true })
  fs.writeFileSync(configPath, `${JSON.stringify({ servers }, null, 2)}\n`, 'utf8')
  return configPath
}

function createConfig(configPath: string, env: Record<string, string>): McpConfig {
  return new McpConfig({
    configPath,
    logger: silentLogger,
    repoRoot: REPO_ROOT,
    env: env as NodeJS.ProcessEnv,
  })
}

const STDIO_SERVER = {
  id: 'data-center',
  name: '数据中心',
  transport: 'stdio',
  command: 'node',
  args: ['${REPO_ROOT}/scripts/mcp-data-center-server.mjs'],
  env: { DATA_CENTER_TOKEN: '${DATA_CENTER_TOKEN}' },
  headers: {},
  toolCallTimeoutMs: 30000,
  failOnStartup: false,
  enabled: true,
}

describe('parseValueExpression', () => {
  it('整个值是引用 → env', () => {
    expect(parseValueExpression('${TOKEN}')).toEqual({ kind: 'env', name: 'TOKEN' })
  })

  it('内嵌引用 → template（记录所有变量名）', () => {
    expect(parseValueExpression('Bearer ${TOKEN}')).toEqual({
      kind: 'template',
      template: 'Bearer ${TOKEN}',
      names: ['TOKEN'],
    })
  })

  it('字面量原样保留', () => {
    expect(parseValueExpression('http://localhost:9100/mcp')).toEqual({
      kind: 'literal',
      value: 'http://localhost:9100/mcp',
    })
  })
})

describe('resolvePathPlaceholders', () => {
  it('展开 ${REPO_ROOT}', () => {
    expect(resolvePathPlaceholders('${REPO_ROOT}/scripts/x.mjs', REPO_ROOT, 'args')).toBe(
      'E:/repo/scripts/x.mjs',
    )
  })

  it('把凭据写在 command/args/url 里直接报错', () => {
    expect(() => resolvePathPlaceholders('${SECRET}', REPO_ROOT, 'args')).toThrow(/env \/ headers/)
  })
})

describe('McpConfig.resolveForRuntime', () => {
  it('只保留引用，不展开真实值', () => {
    const root = makeTempDir('mcp-ref-')
    const config = createConfig(writeConfig(root, [STDIO_SERVER]), { DATA_CENTER_TOKEN: 'super-secret' })
    const definition = config.get('data-center') as McpServerDefinition
    const runtime = config.resolveForRuntime(definition)

    expect(runtime.env.DATA_CENTER_TOKEN).toEqual({ kind: 'env', name: 'DATA_CENTER_TOKEN' })
    expect(runtime.envNames).toEqual(['DATA_CENTER_TOKEN'])
    expect(runtime.args[0]).toBe('E:/repo/scripts/mcp-data-center-server.mjs')
    // 任何地方都不应出现真实值
    expect(JSON.stringify(runtime)).not.toContain('super-secret')
  })

  it('引用了未设置的变量 → 立即失败（fail closed）', () => {
    const root = makeTempDir('mcp-missing-')
    const config = createConfig(writeConfig(root, [STDIO_SERVER]), {})
    const definition = config.get('data-center') as McpServerDefinition
    expect(() => config.resolveForRuntime(definition)).toThrow(/未设置的环境变量/)
  })

  it('stdio 缺 command → 400', () => {
    const root = makeTempDir('mcp-nocmd-')
    const config = createConfig(
      writeConfig(root, [{ ...STDIO_SERVER, command: undefined, env: {} }]),
      {},
    )
    const definition = config.get('data-center') as McpServerDefinition
    expect(() => config.resolveForRuntime(definition)).toThrow(/缺少 command/)
  })
})

describe('renderMcpPatch（凭据不落盘）', () => {
  it('stdio：env 渲染成 !!js 引用，YAML 里没有真实 token', () => {
    const root = makeTempDir('mcp-render-')
    const config = createConfig(writeConfig(root, [STDIO_SERVER]), { DATA_CENTER_TOKEN: 'super-secret' })
    const definition = config.get('data-center') as McpServerDefinition
    const yaml = renderMcpPatch([config.resolveForRuntime(definition)], 'E:/runtime/workspace')

    expect(yaml).toContain('serverName: "data-center"')
    expect(yaml).toContain('DATA_CENTER_TOKEN: !!js')
    expect(yaml).toContain('process.env.DATA_CENTER_TOKEN')
    expect(yaml).not.toContain('super-secret')
  })

  it('http：headers 支持内嵌模板', () => {
    const root = makeTempDir('mcp-http-')
    const config = createConfig(
      writeConfig(root, [
        {
          id: 'gis-service',
          name: 'GIS',
          transport: 'streamable-http',
          url: 'http://127.0.0.1:9100/mcp',
          headers: { Authorization: 'Bearer ${GIS_TOKEN}' },
          env: {},
          args: [],
          toolCallTimeoutMs: 5000,
          failOnStartup: false,
          enabled: true,
        },
      ]),
      { GIS_TOKEN: 'secret-token' },
    )
    const definition = config.get('gis-service') as McpServerDefinition
    const yaml = renderMcpPatch([config.resolveForRuntime(definition)], 'E:/w')

    expect(yaml).toContain('transport: streamable-http')
    expect(yaml).toContain('url: "http://127.0.0.1:9100/mcp"')
    expect(yaml).toContain('Authorization: !!js')
    expect(yaml).toContain('Bearer')
    expect(yaml).toContain('process.env.GIS_TOKEN')
    expect(yaml).not.toContain('secret-token')
  })

  it('没有服务器时输出合法空数组', () => {
    expect(renderMcpPatch([], 'E:/w')).toContain('[]')
  })
})

describe('probeTarget', () => {
  it('只在探测目标里出现真实值（用于连接测试）', () => {
    const root = makeTempDir('mcp-probe-')
    const config = createConfig(writeConfig(root, [STDIO_SERVER]), { DATA_CENTER_TOKEN: 'probe-secret' })
    const definition = config.get('data-center') as McpServerDefinition
    const target = config.probeTarget(definition, 20000)

    expect(target.env.DATA_CENTER_TOKEN).toBe('probe-secret')
    expect(target.command).toBe('node')
    expect(target.timeoutMs).toBe(20000)
  })
})
