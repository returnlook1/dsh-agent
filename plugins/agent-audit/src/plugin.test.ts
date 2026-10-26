/**
 * `agent-audit` behaviour through the **built** plugin module.
 *
 * Covers requirement #8 (loadable ESM Cordis plugin), the two-line-per-call
 * contract, `durationMs` pairing, the `post-execute` block branch with dedupe, the
 * policy→audit decision bridge, and the "audit must never break execution" rule.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIST_URL = new URL('../dist/index.js', import.meta.url)
if (!existsSync(DIST_URL)) {
  throw new Error('dist/index.js 不存在：请先运行 `npm run build -w @agent-studio/plugin-agent-audit` 再跑测试')
}
const plugin = await import(DIST_URL.href)

interface FakeExec {
  callId: string
  name: string
  arguments: unknown
  agent?: { id: string }
  signal: AbortSignal
}

type NextPre = () => Promise<{ kind: string }>
type NextPost = () => Promise<{ kind: string }>

interface FakeCtx {
  tools: { register(def: unknown): () => void }
  on(name: string, fn: (...args: never[]) => unknown): () => void
  effect(fn: () => unknown): () => void
}

function createFakeCtx(): { ctx: FakeCtx; listeners: Map<string, Array<(...args: never[]) => unknown>> } {
  const listeners = new Map<string, Array<(...args: never[]) => unknown>>()
  const ctx: FakeCtx = {
    tools: { register: () => () => {} },
    on(name, fn) {
      const existing = listeners.get(name) ?? []
      existing.push(fn)
      listeners.set(name, existing)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? (disposer as () => void) : () => {}
    },
  }
  return { ctx, listeners }
}

function makeExec(overrides: Partial<FakeExec> = {}): FakeExec {
  return {
    callId: 'call-1',
    name: 'query_station',
    arguments: { stationId: 'ST-001', days: 7 },
    agent: { id: 'dsh-session-1' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

function readAudit(auditPath: string): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

/** Install a policy verdict the way `agent-policy` would, through the shared symbol. */
function seedDecision(callId: string, decision: string, approvalId?: string): void {
  const key = Symbol.for('@agent-studio/tool-audit-bridge/v1')
  const host = globalThis as unknown as Record<symbol, { entries: Map<string, unknown> } | undefined>
  const store = host[key] ?? { entries: new Map<string, unknown>() }
  host[key] = store
  store.entries.set(callId, approvalId === undefined ? { decision } : { decision, approvalId })
}

function success() {
  return { isError: false as const, value: { ok: true }, content: [{ type: 'text' as const, text: 'ok' }] }
}

function failure(message: string) {
  return {
    isError: true as const,
    error: { message },
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
  }
}

describe('agent-audit plugin module', () => {
  it('exports the Cordis plugin shape', () => {
    expect(plugin.name).toBe('agent-audit')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('writes one result line with status, duration, preview and digest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    const auditPath = join(root, 'audit', 'tool-calls.jsonl')
    let clock = 1_000
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { auditPath, now: () => clock })

    const pre = listeners.get('tools/pre-execute')?.[0] as (exec: FakeExec, next: NextPre) => Promise<{ kind: string }>
    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined

    expect(await pre(makeExec({ callId: 'call-ok' }), async () => ({ kind: 'allow' }))).toEqual({ kind: 'allow' })

    clock = 1_042
    result(makeExec({ callId: 'call-ok' }), success())

    const records = readAudit(auditPath)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      callId: 'call-ok',
      tool: 'query_station',
      decision: 'allow',
      status: 'succeeded',
      durationMs: 42,
      argumentsPreview: '{"stationId":"ST-001","days":7}',
    })
    expect(records[0]?.['argumentsDigest']).toMatch(/^[0-9a-f]{64}$/)
    expect(records[0]?.['error']).toBeUndefined()
  })

  it('marks a failed call and keeps the error message', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    const auditPath = join(root, 'tool-calls.jsonl')
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { auditPath })

    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined
    result(makeExec({ callId: 'call-fail' }), failure('站点 ST-001 不在授权范围内'))

    const records = readAudit(auditPath)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      decision: 'deny',
      status: 'failed',
      error: '站点 ST-001 不在授权范围内',
    })
  })

  it('takes the policy decision and approval id from the bridge', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    const auditPath = join(root, 'tool-calls.jsonl')
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { auditPath })

    seedDecision('call-asked', 'approved', 'approval-123')
    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined
    result(makeExec({ callId: 'call-asked', name: 'export_report' }), success())

    const record = readAudit(auditPath).find((entry) => entry['callId'] === 'call-asked')
    expect(record).toMatchObject({ decision: 'approved', approvalId: 'approval-123', status: 'succeeded' })
  })

  it('records a post-execute block exactly once', async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    const auditPath = join(root, 'tool-calls.jsonl')
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { auditPath })

    const pre = listeners.get('tools/pre-execute')?.[0] as (exec: FakeExec, next: NextPre) => Promise<{ kind: string }>
    const post = listeners.get('tools/post-execute')?.[0] as (
      exec: FakeExec,
      result: unknown,
      next: NextPost,
    ) => Promise<{ kind: string }>
    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined

    await pre(makeExec({ callId: 'call-blocked' }), async () => ({ kind: 'allow' }))
    const decision = await post(makeExec({ callId: 'call-blocked' }), success(), async () => ({ kind: 'block' }))
    expect(decision).toEqual({ kind: 'block' })
    // The pipeline still notifies tools/result; the line must not be duplicated.
    result(makeExec({ callId: 'call-blocked' }), failure('blocked by post-execute policy'))

    const records = readAudit(auditPath).filter((entry) => entry['callId'] === 'call-blocked')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ status: 'failed', error: 'blocked by post-execute policy' })
  })

  it('does not double-record a policy denial that already wrote its own line', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    const auditPath = join(root, 'tool-calls.jsonl')
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { auditPath })

    // The policy plugin recorded the denial itself (decision=deny, status=denied).
    writeFileSync(
      auditPath,
      `${JSON.stringify({
        id: 'policy-line',
        callId: 'call-denied',
        tool: 'query_station',
        decision: 'deny',
        status: 'denied',
        error: '工具 query_station 未获得授权',
      })}\n`,
      'utf8',
    )
    // The registry still emits a failure result for the same call.
    seedDecision('call-denied', 'deny')
    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined
    result(makeExec({ callId: 'call-denied' }), failure('工具 query_station 未获得授权'))

    const records = readAudit(auditPath).filter((entry) => entry['callId'] === 'call-denied')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ decision: 'deny', status: 'denied' })
  })

  it('never breaks execution when the audit log cannot be written', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    // A directory where the log file should be: appendFileSync fails with EISDIR.
    const auditPath = join(root, 'audit-dir')
    const { ctx, listeners } = createFakeCtx()
    writeFileSync(join(root, 'seed'), 'x', 'utf8')
    plugin.apply(ctx, { auditPath })

    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined
    expect(() => result(makeExec(), success())).not.toThrow()
  })

  it('degrades to a no-op when no audit path is configured', () => {
    const { ctx, listeners } = createFakeCtx()
    const previousAudit = process.env['AGENT_STUDIO_AUDIT_PATH']
    const previousPolicy = process.env['AGENT_STUDIO_POLICY']
    delete process.env['AGENT_STUDIO_AUDIT_PATH']
    delete process.env['AGENT_STUDIO_POLICY']
    try {
      plugin.apply(ctx)
      const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined
      expect(() => result(makeExec(), success())).not.toThrow()
    } finally {
      if (previousAudit !== undefined) process.env['AGENT_STUDIO_AUDIT_PATH'] = previousAudit
      if (previousPolicy !== undefined) process.env['AGENT_STUDIO_POLICY'] = previousPolicy
    }
  })

  it('writes single-line JSON records with exactly the contract fields', () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-audit-'))
    const auditPath = join(root, 'tool-calls.jsonl')
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { auditPath })

    const result = listeners.get('tools/result')?.[0] as (exec: FakeExec, value: unknown) => undefined
    result(makeExec({ callId: 'call-shape' }), success())

    const raw = readFileSync(auditPath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const record = JSON.parse(raw.trim()) as Record<string, unknown>
    expect(Object.keys(record).sort()).toEqual(
      [
        'agentId',
        'agentVersion',
        'argumentsDigest',
        'argumentsPreview',
        'at',
        'callId',
        'decision',
        'id',
        'runtimeId',
        'sessionId',
        'status',
        'tool',
        'userId',
      ].sort(),
    )
    expect(typeof record['agentVersion']).toBe('number')
    expect(Number.isInteger(record['agentVersion'])).toBe(true)
  })
})
