/**
 * Matcher matrix for `resolveToolAction` / `isToolAllowed`.
 *
 * Pinned properties: deny wins over allow/ask, trailing `*` works for allow/ask
 * *and* deny entries, ask beats allow on overlap, and an unmatched tool is denied.
 */
import { describe, expect, it } from 'vitest'

import type { PolicySnapshot, ToolAction } from './contracts.js'
import { isToolAllowed, matchesToolPattern, resolveToolAction } from './policy.js'

function snapshot(tools: Record<string, ToolAction>, maxToolCalls = 0): PolicySnapshot {
  return Object.freeze({
    snapshotVersion: 1,
    agentId: 'agent-1',
    agentVersion: 1,
    runtimeId: 'rt-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    issuedAt: 1,
    tools: Object.freeze({ ...tools }),
    defaultAction: 'deny' as const,
    approvalTimeoutMs: 1000,
    controlDir: '/tmp/control',
    auditPath: '/tmp/audit.jsonl',
    maxToolCalls,
    maxTurns: 20,
  })
}

describe('matchesToolPattern', () => {
  it('matches exact names only when there is no wildcard', () => {
    expect(matchesToolPattern('query_station', 'query_station')).toBe(true)
    expect(matchesToolPattern('query_station', 'query_station_v2')).toBe(false)
    expect(matchesToolPattern('query_*', 'query_station')).toBe(true)
  })

  it('supports a trailing-star prefix pattern', () => {
    expect(matchesToolPattern('mcp__water__*', 'mcp__water__read')).toBe(true)
    expect(matchesToolPattern('mcp__water__*', 'mcp__air__read')).toBe(false)
    expect(matchesToolPattern('*', 'anything')).toBe(true)
  })
})

describe('resolveToolAction', () => {
  it('denies a tool that is not listed at all', () => {
    expect(resolveToolAction(snapshot({ search_datasets: 'allow' }), 'run_shell')).toBe('deny')
    expect(isToolAllowed(snapshot({ search_datasets: 'allow' }), 'run_shell')).toBe(false)
  })

  it('lets an exact deny beat an allow wildcard', () => {
    const policy = snapshot({ 'mcp__*': 'allow', 'mcp__water__drop': 'deny' })
    expect(resolveToolAction(policy, 'mcp__water__drop')).toBe('deny')
    expect(resolveToolAction(policy, 'mcp__water__read')).toBe('allow')
  })

  it('lets a deny wildcard beat an allow wildcard', () => {
    const policy = snapshot({ 'mcp__*': 'allow', 'mcp__water__*': 'deny' })
    expect(resolveToolAction(policy, 'mcp__water__read')).toBe('deny')
  })

  it('prefers ask over allow when both patterns match', () => {
    const policy = snapshot({ 'export_*': 'allow', export_report: 'ask' })
    expect(resolveToolAction(policy, 'export_report')).toBe('ask')
    expect(isToolAllowed(policy, 'export_report')).toBe(true)
  })

  it('resolves allow for a granted tool', () => {
    const policy = snapshot({ search_datasets: 'allow', export_report: 'ask' })
    expect(resolveToolAction(policy, 'search_datasets')).toBe('allow')
    expect(isToolAllowed(policy, 'search_datasets')).toBe(true)
    expect(resolveToolAction(policy, 'export_report')).toBe('ask')
  })

  it('denies when the only matching entry denies', () => {
    const policy = snapshot({ query_station: 'deny' })
    expect(isToolAllowed(policy, 'query_station')).toBe(false)
  })
})
