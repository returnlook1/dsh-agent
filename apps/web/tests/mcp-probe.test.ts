/**
 * MCP 探测响应的纯解析 / 错误映射单测。
 *
 * 不启动任何 MCP 子进程：只覆盖 JSON → DTO 的窄化与失败文案归类。
 */
import { describe, expect, it } from 'vitest'

import {
  AgentApiError,
  describeMcpProbeError,
  describeMcpProbeFailure,
  parseMcpProbeResponse,
  parseMcpServerCatalog,
  parseStopConversationResponse,
} from '../src/services/agent-api'

function probe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    serverId: 'data-center',
    tools: [],
    durationMs: 321,
    transport: 'stdio',
    ...overrides,
  }
}

describe('parseMcpProbeResponse', () => {
  it('解析成功的探测结果（工具、协议版本、服务器名）', () => {
    const parsed = parseMcpProbeResponse(
      probe({
        serverName: '数据中心',
        protocolVersion: '2025-03-26',
        durationMs: 1234.5,
        tools: [
          {
            name: 'list_datasets',
            description: '列出数据集',
            inputSchema: { type: 'object', properties: { keyword: { type: 'string' } } },
          },
          { name: 'no_schema' },
        ],
      }),
    )

    expect(parsed).toMatchObject({
      ok: true,
      serverId: 'data-center',
      serverName: '数据中心',
      protocolVersion: '2025-03-26',
      transport: 'stdio',
      durationMs: 1234.5,
    })
    expect(parsed.tools).toHaveLength(2)
    expect(parsed.tools[0]).toMatchObject({
      name: 'list_datasets',
      description: '列出数据集',
      inputSchema: { type: 'object' },
    })
    expect(parsed.tools[1]?.inputSchema).toBeUndefined()
  })

  it('tools 为空数组是合法结果（服务器没有工具）', () => {
    const parsed = parseMcpProbeResponse(probe({ tools: [] }))
    expect(parsed.ok).toBe(true)
    expect(parsed.tools).toEqual([])
  })

  it('解析失败的探测结果，保留后端 error', () => {
    const parsed = parseMcpProbeResponse(
      probe({ ok: false, error: 'spawn ENOENT', durationMs: 87, tools: [] }),
    )
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('spawn ENOENT')
    expect(describeMcpProbeFailure(parsed)).toBe('spawn ENOENT')
  })

  it('缺少 tools / transport / durationMs 时抛契约错误', () => {
    expect(() => parseMcpProbeResponse(probe({ tools: undefined }))).toThrowError(AgentApiError)
    expect(() => parseMcpProbeResponse(probe({ transport: 'sse' }))).toThrowError(/transport/)
    expect(() => parseMcpProbeResponse(probe({ durationMs: -1 }))).toThrowError(/durationMs/)
    expect(() => parseMcpProbeResponse(probe({ ok: 'yes' }))).toThrowError(/ok/)
    expect(() => parseMcpProbeResponse(null)).toThrowError(/不是对象/)
  })

  it('工具条目缺少 name 时抛契约错误', () => {
    expect(() => parseMcpProbeResponse(probe({ tools: [{ description: 'bad' }] }))).toThrowError(/name/)
  })
})

describe('MCP 失败文案', () => {
  it('超时错误给出可读文案（含等待时长）', () => {
    const parsed = parseMcpProbeResponse(
      probe({ ok: false, error: 'request timed out after 20000ms', durationMs: 20_000 }),
    )
    const message = describeMcpProbeFailure(parsed)
    expect(message).toContain('探测超时')
    expect(message).toContain('20.00 s')
    expect(message).toContain('request timed out')
  })

  it('中文超时 / ETIMEDOUT 也归类为超时', () => {
    expect(
      describeMcpProbeFailure(
        parseMcpProbeResponse(probe({ ok: false, error: '连接超时', durationMs: 500 })),
      ),
    ).toContain('探测超时')
    expect(
      describeMcpProbeFailure(
        parseMcpProbeResponse(probe({ ok: false, error: 'connect ETIMEDOUT', durationMs: 500 })),
      ),
    ).toContain('探测超时')
  })

  it('没有 error 时给出兜底原因，不只显示空白', () => {
    const message = describeMcpProbeFailure(
      parseMcpProbeResponse(probe({ ok: false, tools: [], durationMs: 42 })),
    )
    expect(message).toContain('MCP 探测失败')
    expect(message).toContain('未返回原因')
  })

  it('请求层错误（网络 / 取消 / 超时）映射为可见文案', () => {
    expect(describeMcpProbeError(new AgentApiError(0, 'NETWORK_ERROR', '无法连接服务'))).toBe(
      '无法连接服务',
    )
    expect(describeMcpProbeError(new AgentApiError(0, 'ABORTED', '请求已取消'))).toBe(
      'MCP 探测已取消',
    )
    expect(describeMcpProbeError(new AgentApiError(504, 'TIMEOUT', 'upstream timeout'))).toContain(
      '探测超时',
    )
    expect(describeMcpProbeError('boom')).toBe('boom')
  })
})

describe('其余契约解析', () => {
  it('stop 响应解析 ok / runtimeClosed / note', () => {
    expect(parseStopConversationResponse({ ok: true, runtimeClosed: false, note: '仅解绑 SSE' })).toEqual({
      ok: true,
      runtimeClosed: false,
      note: '仅解绑 SSE',
    })
    expect(() => parseStopConversationResponse({ ok: true })).toThrowError(/runtimeClosed/)
  })

  it('MCP 清单解析 source 与 dshSource', () => {
    const catalog = parseMcpServerCatalog({
      servers: [
        { id: 'a', name: 'A', transport: 'stdio', enabled: true, source: 'config' },
        { id: 'b', name: 'B', transport: 'streamable-http', source: 'dsh-profile' },
      ],
      configPath: 'config/mcp-servers.json',
      dshSource: 'C:\\Users\\me\\.dsh#desktop',
    })
    expect(catalog.dshSource).toBe('C:\\Users\\me\\.dsh#desktop')
    expect(catalog.servers.map((server) => server.source)).toEqual(['config', 'dsh-profile'])
    expect(catalog.servers[1]?.enabled).toBe(true)
  })
})
