import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { AgentEvent } from '@agent-studio/shared'
import { createContext, createConfig } from '../helpers.js'
import { ApprovalBridge } from '../../src/runtime/ApprovalBridge.js'
import type { AppContext } from '../../src/context.js'
import type { GatewayDatabase } from '../../src/db/database.js'

let ctx: AppContext
let db: GatewayDatabase
let root: string
let controlDir: string
let sessionId: string
let userId: string
let events: AgentEvent[]

beforeAll(() => {
  const created = createContext(createConfig())
  ctx = created.ctx
  db = created.db
  root = created.root
  userId = ctx.repos.users.findByUsername('admin')?.id ?? ''
  const session = ctx.repos.sessions.create({
    id: 'approval-session',
    userId,
    agentId: 'approval-agent',
    agentVersion: 1,
    title: '',
  })
  sessionId = session.id
  controlDir = path.join(root, 'control')
  events = []
  ctx.hub.subscribe(sessionId, (event) => events.push(event))
})

afterAll(() => {
  ctx.hub.shutdown()
  db.close()
  fs.rmSync(root, { recursive: true, force: true })
})

function makeBridge(approvalTimeoutMs = 120_000): ApprovalBridge {
  return new ApprovalBridge({
    controlDir,
    sessionId,
    runtimeId: 'rt-approval',
    userId,
    approvalTimeoutMs,
    approvals: ctx.repos.approvals,
    hub: ctx.hub,
    logger: ctx.logger,
  })
}

function writeRequest(approvalId: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(controlDir, 'approvals')
  fs.mkdirSync(dir, { recursive: true })
  const payload = {
    approvalId,
    callId: `call-${approvalId}`,
    tool: 'query_station',
    description: '查询站点 A',
    argumentsPreview: '{"station":"A"}',
    argumentsDigest: 'digest-1',
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  }
  fs.writeFileSync(path.join(dir, `${approvalId}.request.json`), JSON.stringify(payload))
}

function readDecision(approvalId: string): { decision: string; decidedBy: string; reason?: string } {
  const file = path.join(controlDir, 'approvals', `${approvalId}.decision.json`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as { decision: string; decidedBy: string; reason?: string }
}

describe('ApprovalBridge', () => {
  it('畸形请求 fail closed：写拒绝决定且不落库', () => {
    const bridge = makeBridge()
    const dir = path.join(controlDir, 'approvals')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'malformed.request.json'), '{not json')
    bridge.scan()
    expect(readDecision('malformed').decision).toBe('rejected')
    expect(ctx.repos.approvals.getByApprovalId(sessionId, 'malformed')).toBeUndefined()
    bridge.stop()
  })

  it('合法请求落库并推送 approval.required，决定原子写入', () => {
    const bridge = makeBridge()
    writeRequest('a1')
    bridge.scan()

    const row = ctx.repos.approvals.getByApprovalId(sessionId, 'a1')
    expect(row?.status).toBe('pending')
    const required = events.find((event) => event.type === 'approval.required')
    expect(required).toMatchObject({ approvalId: 'a1', tool: 'query_station' })

    const result = bridge.decide('a1', 'allowed-once', userId)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('allowed')
    expect(ctx.repos.approvals.getByApprovalId(sessionId, 'a1')?.status).toBe('allowed')
    expect(readDecision('a1')).toMatchObject({ decision: 'allowed-once', decidedBy: userId })
    expect(events.some((event) => event.type === 'approval.decided' && event.approvalId === 'a1')).toBe(true)
    bridge.stop()
  })

  it('已过期请求在接纳时直接置 expired 并写拒绝决定', () => {
    const bridge = makeBridge()
    writeRequest('a2', { expiresAt: Date.now() - 5_000 })
    bridge.scan()
    expect(ctx.repos.approvals.getByApprovalId(sessionId, 'a2')?.status).toBe('expired')
    expect(readDecision('a2').decision).toBe('rejected')
    bridge.stop()
  })

  it('等待超时后 scanExpired 置 expired（不是 allowed）', async () => {
    const bridge = makeBridge(25)
    writeRequest('a3', { expiresAt: Date.now() + 60_000 })
    bridge.scan()
    expect(ctx.repos.approvals.getByApprovalId(sessionId, 'a3')?.status).toBe('pending')
    await new Promise((resolve) => setTimeout(resolve, 60))
    bridge.scanExpired()
    expect(ctx.repos.approvals.getByApprovalId(sessionId, 'a3')?.status).toBe('expired')
    expect(readDecision('a3').decision).toBe('rejected')
    bridge.stop()
  })

  it('运行时关闭时 expirePending 拒绝所有未决审批', () => {
    const bridge = makeBridge()
    writeRequest('a4')
    bridge.scan()
    bridge.expirePending('runtime stopped')
    expect(ctx.repos.approvals.getByApprovalId(sessionId, 'a4')?.status).toBe('expired')
    expect(readDecision('a4').reason).toContain('runtime stopped')
    bridge.stop()
  })

  it('重复扫描同一请求不会重复落库或重复弹审批', () => {
    const bridge = makeBridge()
    writeRequest('a5')
    bridge.scan()
    bridge.scan()
    const rows = ctx.repos.approvals.listBySession(sessionId).filter((row) => row.approval_id === 'a5')
    expect(rows).toHaveLength(1)
    const requiredForA5 = events.filter((event) => event.type === 'approval.required' && event.approvalId === 'a5')
    expect(requiredForA5).toHaveLength(1)
    bridge.stop()
  })
})
