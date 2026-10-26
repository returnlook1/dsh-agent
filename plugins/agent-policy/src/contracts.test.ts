/**
 * Snapshot validation: defaults, rejections, and (when the sibling workspace is
 * importable) an equivalence matrix against the authoritative
 * `policySnapshotSchema` in `packages/shared/src/policy.ts`.
 *
 * The plugin cannot import that module at runtime, so the validator is hand
 * written; this test is what keeps the copy honest.
 */
import { describe, expect, it } from 'vitest'

import { parsePolicySnapshot, PolicyConfigError } from './contracts.js'

function base(): Record<string, unknown> {
  return {
    agentId: 'agent-1',
    agentVersion: 1,
    runtimeId: 'rt-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    issuedAt: 1_758_000_000_000,
    tools: { search_datasets: 'allow' },
    controlDir: '/control',
    auditPath: '/audit/tool-calls.jsonl',
  }
}

describe('parsePolicySnapshot', () => {
  it('applies the schema defaults', () => {
    const snapshot = parsePolicySnapshot(base())
    expect(snapshot.snapshotVersion).toBe(1)
    expect(snapshot.defaultAction).toBe('deny')
    expect(snapshot.approvalTimeoutMs).toBe(120_000)
    expect(snapshot.maxToolCalls).toBe(0)
    expect(snapshot.maxTurns).toBe(20)
    expect(snapshot.tools).toEqual({ search_datasets: 'allow' })
  })

  it('rejects a snapshot without the required identity fields', () => {
    const broken = base()
    delete broken['agentId']
    expect(() => parsePolicySnapshot(broken)).toThrow(PolicyConfigError)
    expect(() => parsePolicySnapshot(broken)).toThrow(/agentId/)
  })

  it('rejects an unknown tool action', () => {
    expect(() => parsePolicySnapshot({ ...base(), tools: { search_datasets: 'ALLOW' } })).toThrow(/allow \/ deny \/ ask/)
  })

  it('rejects a non-deny default action', () => {
    expect(() => parsePolicySnapshot({ ...base(), defaultAction: 'allow' })).toThrow(/defaultAction/)
  })

  it('rejects an unsupported snapshot version', () => {
    expect(() => parsePolicySnapshot({ ...base(), snapshotVersion: 2 })).toThrow(/snapshotVersion/)
  })

  it('rejects a non-positive approval timeout', () => {
    expect(() => parsePolicySnapshot({ ...base(), approvalTimeoutMs: 0 })).toThrow(/approvalTimeoutMs/)
  })

  it('rejects a negative tool-call budget', () => {
    expect(() => parsePolicySnapshot({ ...base(), maxToolCalls: -1 })).toThrow(/maxToolCalls/)
  })

  it('rejects non-objects and arrays', () => {
    expect(() => parsePolicySnapshot(null)).toThrow(PolicyConfigError)
    expect(() => parsePolicySnapshot([])).toThrow(PolicyConfigError)
    expect(() => parsePolicySnapshot('nope')).toThrow(PolicyConfigError)
  })

  it('ignores unknown extra keys, like zod object mode does', () => {
    expect(() => parsePolicySnapshot({ ...base(), somethingElse: true })).not.toThrow()
  })
})

/** Matrix shared by the local validator and the zod schema. */
const CASES: Array<[label: string, value: () => unknown]> = [
  ['minimal valid snapshot', () => base()],
  ['explicit defaults', () => ({ ...base(), snapshotVersion: 1, defaultAction: 'deny' })],
  ['empty tools map', () => ({ ...base(), tools: {} })],
  ['unknown tool action', () => ({ ...base(), tools: { search_datasets: 'ALLOW' } })],
  ['missing tools', () => { const value = base(); delete value['tools']; return value }],
  ['missing agentId', () => { const value = base(); delete value['agentId']; return value }],
  ['non-string userId', () => ({ ...base(), userId: 42 })],
  ['negative agentVersion (allowed: schema has no bound)', () => ({ ...base(), agentVersion: -1 })],
  ['fractional agentVersion', () => ({ ...base(), agentVersion: 1.5 })],
  ['zero approvalTimeoutMs', () => ({ ...base(), approvalTimeoutMs: 0 })],
  ['fractional maxTurns', () => ({ ...base(), maxTurns: 2.5 })],
  ['negative maxToolCalls', () => ({ ...base(), maxToolCalls: -2 })],
  ['defaultAction allow', () => ({ ...base(), defaultAction: 'allow' })],
  ['snapshotVersion 2', () => ({ ...base(), snapshotVersion: 2 })],
  ['non-finite issuedAt', () => ({ ...base(), issuedAt: Number.NaN })],
  ['extra keys', () => ({ ...base(), extra: { nested: 1 } })],
  ['null', () => null],
  ['array', () => []],
  ['string', () => 'policy'],
]

type SharedPolicyModule = {
  policySnapshotSchema: { safeParse: (value: unknown) => { success: boolean } }
}

/**
 * Locate the sibling workspace's schema. `packages/shared` must never be a
 * dependency of the plugin (it exports zod schemas as values); this test only
 * reads its source to keep the hand-written validator honest.
 *
 * Candidate 1 is the TS source, which vitest can transform. Candidate 2 is an
 * optional precompiled copy for environments where the TypeScript transform
 * cannot run (`.tmp-test-shared/policy.js`); when neither loads, the cross-check
 * is skipped rather than failing the suite.
 */
const sharedCandidates = [
  new URL('../../../packages/shared/src/policy.ts', import.meta.url),
  new URL('../../.tmp-test-shared/policy.js', import.meta.url),
]

let shared: SharedPolicyModule | undefined
for (const candidate of sharedCandidates) {
  try {
    shared = (await import(candidate.href)) as unknown as SharedPolicyModule
    break
  } catch {
    // try the next location
  }
}

describe('equivalence with packages/shared policySnapshotSchema', () => {
  it.skipIf(shared === undefined)('accepts and rejects exactly the same inputs', () => {
    const schema = shared?.policySnapshotSchema
    if (schema === undefined) return

    for (const [label, make] of CASES) {
      const value = make()
      const zodAccepted = schema.safeParse(value).success
      let localAccepted = true
      try {
        parsePolicySnapshot(value)
      } catch {
        localAccepted = false
      }
      expect(localAccepted, `case: ${label}`).toBe(zodAccepted)
    }
  })
})
