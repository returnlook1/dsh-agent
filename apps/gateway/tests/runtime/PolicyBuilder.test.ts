import { describe, expect, it } from 'vitest'
import { agentConfigSchema } from '@agent-studio/shared'
import { buildPolicy, PolicyViolationError } from '../../src/runtime/PolicyBuilder.js'

const baseInput = {
  agentVersion: 3,
  runtimeId: 'rt-1',
  sessionId: 'sess-1',
  userId: 'user-1',
  controlDir: 'E:/runtime/control',
  auditPath: 'E:/runtime/audit/tool-calls.jsonl',
  approvalTimeoutMs: 120_000,
  now: 1_700_000_000_000,
}

function config(overrides: Record<string, unknown> = {}) {
  return agentConfigSchema.parse({
    id: 'agent-1',
    name: 'Agent One',
    ...overrides,
  })
}

const allowAllLookup = { supportsApprovalChannel: () => true }
const denyAllLookup = { supportsApprovalChannel: () => false }

describe('PolicyBuilder', () => {
  it('允许 MCP 尾部通配并把工具写进快照', () => {
    const result = buildPolicy({
      ...baseInput,
      config: config({ capabilities: { tools: { 'mcp__water__*': 'allow' } } }),
      toolLookup: allowAllLookup,
    })
    expect(result.snapshot.tools).toEqual({ 'mcp__water__*': 'allow' })
    expect(result.snapshot.defaultAction).toBe('deny')
    expect(result.snapshot.snapshotVersion).toBe(1)
    expect(result.snapshot.agentVersion).toBe(3)
    expect(result.snapshot.approvalTimeoutMs).toBe(120_000)
    expect(result.snapshot.maxTurns).toBe(20)
    expect(result.warnings).toEqual([])
  })

  it('deny 不写入快照（默认拒绝兜底）', () => {
    const result = buildPolicy({
      ...baseInput,
      config: config({ capabilities: { tools: { 'mcp__water__read': 'deny' } } }),
      toolLookup: allowAllLookup,
    })
    expect(result.snapshot.tools).toEqual({})
  })

  it('无审批通道的 ask 降级为 deny 并产生 warning', () => {
    const result = buildPolicy({
      ...baseInput,
      config: config({ capabilities: { tools: { query_station: 'ask' } } }),
      toolLookup: denyAllLookup,
    })
    expect(result.snapshot.tools.query_station).toBeUndefined()
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.field).toBe('capabilities.tools.query_station')
    expect(result.warnings[0]?.message).toContain('降级为 deny')
  })

  it('有审批通道的 ask 保留为 ask', () => {
    const result = buildPolicy({
      ...baseInput,
      config: config({ capabilities: { tools: { 'mcp__water__read': 'ask' } } }),
      toolLookup: allowAllLookup,
    })
    expect(result.snapshot.tools['mcp__water__read']).toBe('ask')
  })

  it('security.shell 等禁止项直接拒绝', () => {
    expect(() =>
      buildPolicy({
        ...baseInput,
        config: config({ security: { shell: true } }),
        toolLookup: allowAllLookup,
      }),
    ).toThrow(PolicyViolationError)

    expect(() =>
      buildPolicy({
        ...baseInput,
        config: config({ security: { fileWrite: true } }),
        toolLookup: allowAllLookup,
      }),
    ).toThrow(/security\.fileWrite/)
  })

  it('子智能体开启直接拒绝', () => {
    expect(() =>
      buildPolicy({
        ...baseInput,
        config: config({ capabilities: { subagents: true } }),
        toolLookup: allowAllLookup,
      }),
    ).toThrow(/子智能体/)
  })

  it('networkAccess=none 时不挂载 MCP 工具', () => {
    const result = buildPolicy({
      ...baseInput,
      config: config({
        capabilities: { tools: { 'mcp__water__*': 'allow', read_dataset: 'allow' } },
        security: { networkAccess: 'none' },
      }),
      toolLookup: allowAllLookup,
    })
    expect(result.snapshot.tools).toEqual({ read_dataset: 'allow' })
    expect(result.warnings.some((warning) => warning.field.includes('mcp__water__*'))).toBe(true)
  })
})
