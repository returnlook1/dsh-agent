/**
 * End-to-end smoke test through the **built** plugin module.
 *
 * This is the test that proves requirement #8: `dist/index.js` is a loadable ESM
 * Cordis plugin (`name` / `inject` / `apply`) and its real behaviour — snapshot
 * load, deny, allow, revocation kill switch, and the file-channel approval round
 * trip — works against a fake `ctx` shaped like the parts of Cordis the plugin uses.
 *
 * Run `npm run build -w @agent-studio/plugin-agent-policy` first.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

const DIST_URL = new URL('../dist/index.js', import.meta.url)
if (!existsSync(DIST_URL)) {
  throw new Error(
    'dist/index.js 不存在：请先运行 `npm run build -w @agent-studio/plugin-agent-policy` 再跑测试',
  )
}
const plugin = await import(DIST_URL.href)

type Guard = (exec: Readonly<FakeExec>) => string | undefined
type Listener = (exec: FakeExec, next: () => Promise<{ kind: string }>) => Promise<{ kind: string; reason?: string }>

interface FakeExec {
  callId: string
  name: string
  arguments: unknown
  agent?: { id: string }
  signal: AbortSignal
}

interface FakeCtx {
  tools: { guard(fn: Guard): () => void; register(def: unknown): () => void }
  on(name: string, fn: Listener): () => void
  effect(fn: () => unknown): () => void
}

function createFakeCtx(): { ctx: FakeCtx; guards: Guard[]; listeners: Map<string, Listener[]> } {
  const guards: Guard[] = []
  const listeners = new Map<string, Listener[]>()
  const ctx: FakeCtx = {
    tools: {
      guard(fn) {
        guards.push(fn)
        return () => {
          const index = guards.indexOf(fn)
          if (index >= 0) guards.splice(index, 1)
        }
      },
      register() {
        return () => {}
      },
    },
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
  return { ctx, guards, listeners }
}

function makeExec(overrides: Partial<FakeExec> = {}): FakeExec {
  return {
    callId: 'call-1',
    name: 'search_datasets',
    arguments: { keyword: 'water' },
    agent: { id: 'session-1' },
    signal: new AbortController().signal,
    ...overrides,
  }
}

interface Fixture {
  root: string
  policyPath: string
  controlDir: string
  auditPath: string
}

function writeFixture(overrides: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-policy-smoke-'))
  const controlDir = join(root, 'control')
  const auditPath = join(root, 'audit', 'tool-calls.jsonl')
  mkdirSync(controlDir, { recursive: true })
  const snapshot = {
    snapshotVersion: 1,
    agentId: 'agent-1',
    agentVersion: 3,
    runtimeId: 'rt-1',
    sessionId: 'sess-1',
    userId: 'user-1',
    issuedAt: 1_758_000_000_000,
    tools: { search_datasets: 'allow', export_report: 'ask' },
    defaultAction: 'deny',
    approvalTimeoutMs: 2_000,
    controlDir,
    auditPath,
    maxToolCalls: 0,
    maxTurns: 20,
    ...overrides,
  }
  const policyPath = join(root, 'policy.json')
  writeFileSync(policyPath, JSON.stringify(snapshot, null, 2), 'utf8')
  return { root, policyPath, controlDir, auditPath }
}

function readAudit(auditPath: string): Array<Record<string, unknown>> {
  if (!existsSync(auditPath)) return []
  return readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('等待超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function approvalsDir(fixture: Fixture): string {
  return join(fixture.controlDir, 'approvals')
}

function listRequests(fixture: Fixture): string[] {
  const directory = approvalsDir(fixture)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter((name) => name.endsWith('.request.json'))
}

/** Answer one pending approval by writing the decision file the gateway would write. */
function answerApproval(fixture: Fixture, decision: string, reason?: string): string {
  const [requestFile] = listRequests(fixture)
  if (requestFile === undefined) throw new Error('没有待审批请求')
  const request = JSON.parse(readFileSync(join(approvalsDir(fixture), requestFile), 'utf8')) as {
    approvalId: string
  }
  writeFileSync(
    join(approvalsDir(fixture), `${request.approvalId}.decision.json`),
    JSON.stringify({
      approvalId: request.approvalId,
      decision,
      decidedBy: 'tester',
      decidedAt: Date.now(),
      ...(reason === undefined ? {} : { reason }),
    }),
    'utf8',
  )
  return request.approvalId
}

describe('agent-policy plugin module', () => {
  let fixture: Fixture

  beforeEach(() => {
    fixture = writeFixture()
  })

  it('exports the Cordis plugin shape', () => {
    expect(plugin.name).toBe('agent-policy')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
  })

  it('loads a valid snapshot, creates the control channel and an empty audit sink', () => {
    const { ctx } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })

    // Startup proves the sink is writable without inventing a fake audit record.
    expect(existsSync(fixture.auditPath)).toBe(true)
    expect(readAudit(fixture.auditPath)).toEqual([])
    expect(existsSync(approvalsDir(fixture))).toBe(true)
  })

  it('refuses to start without a policy snapshot', () => {
    const { ctx } = createFakeCtx()
    expect(() => plugin.apply(ctx, { policyPath: join(fixture.root, 'missing.json') })).toThrow(
      /策略快照不可读/,
    )

    const previous = process.env['AGENT_STUDIO_POLICY']
    delete process.env['AGENT_STUDIO_POLICY']
    try {
      expect(() => plugin.apply(createFakeCtx().ctx)).toThrow(/AGENT_STUDIO_POLICY/)
    } finally {
      if (previous !== undefined) process.env['AGENT_STUDIO_POLICY'] = previous
    }
  })

  it('refuses to start with an invalid snapshot', () => {
    const broken = writeFixture({ tools: { search_datasets: 'maybe' } })
    const { ctx } = createFakeCtx()
    expect(() => plugin.apply(ctx, { policyPath: broken.policyPath })).toThrow(/策略快照校验失败/)
  })

  it('denies an unauthorized tool and allows an allowlisted one', () => {
    const { ctx, guards } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const guard = guards[0]
    expect(guard).toBeDefined()

    expect(guard?.(makeExec({ name: 'run_shell' }))).toBe('工具 run_shell 未获得授权')
    expect(guard?.(makeExec({ name: 'search_datasets' }))).toBeUndefined()
    expect(guard?.(makeExec({ name: 'export_report' }))).toBeUndefined() // ask still "allowed" at guard level
  })

  it('denies every call once revoked.json appears, and reports its reason', () => {
    const { ctx, guards } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath, revocationCacheMs: 0 })

    expect(guards[0]?.(makeExec({ name: 'search_datasets' }))).toBeUndefined()

    writeFileSync(
      join(fixture.controlDir, 'revoked.json'),
      JSON.stringify({ revoked: true, reason: '管理员停用', at: Date.now() }),
      'utf8',
    )

    expect(guards[0]?.(makeExec({ name: 'search_datasets' }))).toBe('运行已被管理员撤销：管理员停用')
    expect(guards[0]?.(makeExec({ name: 'export_report' }))).toBe('运行已被管理员撤销：管理员停用')
  })

  it('enforces maxToolCalls at the guard', () => {
    const limited = writeFixture({ maxToolCalls: 2 })
    const { ctx, guards } = createFakeCtx()
    plugin.apply(ctx, { policyPath: limited.policyPath })

    expect(guards[0]?.(makeExec({ callId: 'c1' }))).toBeUndefined()
    expect(guards[0]?.(makeExec({ callId: 'c2' }))).toBeUndefined()
    expect(guards[0]?.(makeExec({ callId: 'c3' }))).toBe('工具调用次数超过上限(2)')
  })

  it('denies a tool that the snapshot does not list, with an audit line', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const gate = listeners.get('tools/pre-execute')?.[0]
    expect(gate).toBeDefined()

    const decision = await gate?.(makeExec({ name: 'run_shell', callId: 'call-deny' }), async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(decision?.reason).toContain('run_shell 未获得授权')

    const record = readAudit(fixture.auditPath).find((entry) => entry['callId'] === 'call-deny')
    expect(record).toMatchObject({
      tool: 'run_shell',
      decision: 'deny',
      status: 'denied',
      argumentsPreview: '{"keyword":"water"}',
    })
    expect(record?.['error']).toContain('未获得授权')
    expect(record?.['argumentsDigest']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('records allow decisions and delegates to next()', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const gate = listeners.get('tools/pre-execute')?.[0]

    let downstreamCalls = 0
    const decision = await gate?.(makeExec({ callId: 'call-allow' }), async () => {
      downstreamCalls += 1
      return { kind: 'allow' }
    })
    expect(downstreamCalls).toBe(1)
    expect(decision).toEqual({ kind: 'allow' })

    const record = readAudit(fixture.auditPath).find((entry) => entry['callId'] === 'call-allow')
    expect(record).toMatchObject({ tool: 'search_datasets', decision: 'allow', status: 'started' })
  })

  it('resolves an ask tool through a decision file written by the test', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const gate = listeners.get('tools/pre-execute')?.[0]

    const pending = gate?.(
      makeExec({ name: 'export_report', callId: 'call-ask', arguments: { stationId: 'ST-001', format: 'pdf', token: 'secret' } }),
      async () => ({ kind: 'allow' }),
    )

    await waitFor(() => listRequests(fixture).length === 1)
    const approvalId = answerApproval(fixture, 'allowed-once')

    const decision = await pending
    expect(decision).toEqual({ kind: 'allow' })

    // The request file must be cleaned up, the decision file is the gateway's.
    expect(listRequests(fixture)).toEqual([])

    const record = readAudit(fixture.auditPath).find((entry) => entry['callId'] === 'call-ask')
    expect(record).toMatchObject({ tool: 'export_report', decision: 'approved', status: 'started', approvalId })
    expect(record?.['argumentsPreview']).not.toContain('secret')
  })

  it('denies when the operator rejects, and records the rejection', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const gate = listeners.get('tools/pre-execute')?.[0]

    const pending = gate?.(makeExec({ name: 'export_report', callId: 'call-reject' }), async () => ({ kind: 'allow' }))
    await waitFor(() => listRequests(fixture).length === 1)
    answerApproval(fixture, 'rejected', '不允许导出')

    const decision = await pending
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(decision?.reason).toContain('不允许导出')
    expect(listRequests(fixture)).toEqual([])

    const record = readAudit(fixture.auditPath).find((entry) => entry['callId'] === 'call-reject')
    expect(record).toMatchObject({ decision: 'rejected', status: 'denied' })
  })

  it('denies an unanswered ask when the deadline passes', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath, approvalTimeoutMs: 120 })
    const gate = listeners.get('tools/pre-execute')?.[0]

    const decision = await gate?.(makeExec({ name: 'export_report', callId: 'call-timeout' }), async () => ({ kind: 'allow' }))
    expect(decision).toMatchObject({ kind: 'deny' })
    expect(decision?.reason).toContain('等待审批超时')
    expect(listRequests(fixture)).toEqual([])

    const record = readAudit(fixture.auditPath).find((entry) => entry['callId'] === 'call-timeout')
    expect(record).toMatchObject({ decision: 'expired', status: 'denied' })
  })

  it('cancels the wait when exec.signal aborts, and cleans up the request file', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const gate = listeners.get('tools/pre-execute')?.[0]

    const controller = new AbortController()
    const pending = gate?.(
      makeExec({ name: 'export_report', callId: 'call-abort', signal: controller.signal }),
      async () => ({ kind: 'allow' }),
    )
    await waitFor(() => listRequests(fixture).length === 1)
    controller.abort()

    const decision = await pending
    expect(decision).toEqual({ kind: 'cancel' })
    expect(listRequests(fixture)).toEqual([])

    const record = readAudit(fixture.auditPath).find((entry) => entry['callId'] === 'call-abort')
    expect(record).toMatchObject({ decision: 'cancelled', status: 'cancelled' })
  })

  it('records every line as a single valid JSON object with the audit contract fields', async () => {
    const { ctx, listeners } = createFakeCtx()
    plugin.apply(ctx, { policyPath: fixture.policyPath })
    const gate = listeners.get('tools/pre-execute')?.[0]
    await gate?.(makeExec({ name: 'nope', callId: 'call-shape' }), async () => ({ kind: 'allow' }))

    const raw = readFileSync(fixture.auditPath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    for (const line of raw.split('\n').filter((entry) => entry.length > 0)) {
      const record = JSON.parse(line) as Record<string, unknown>
      expect(Object.keys(record).sort()).toEqual(
        [
          'agentId',
          'agentVersion',
          'argumentsDigest',
          'argumentsPreview',
          'at',
          'callId',
          'decision',
          'error',
          'id',
          'runtimeId',
          'sessionId',
          'status',
          'tool',
          'userId',
        ].sort(),
      )
    }
  })
})
