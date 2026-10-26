import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { agentConfigSchema } from '@agent-studio/shared'
import { GatewayDatabase } from '../../src/db/database.js'
import { seedDatabase } from '../../src/db/seed.js'
import { createContext, createConfig, type TestHarness } from '../helpers.js'
import { AgentsRepository } from '../../src/repositories/agents.js'
import { AgentVersionsRepository } from '../../src/repositories/agentVersions.js'
import type { AppContext } from '../../src/context.js'

let h: { ctx: AppContext; db: GatewayDatabase; root: string }
let adminId: string
let demoId: string

beforeAll(() => {
  h = createContext(createConfig())
  adminId = h.ctx.repos.users.findByUsername('admin')?.id ?? ''
  demoId = h.ctx.repos.users.findByUsername('demo')?.id ?? ''
})

afterAll(() => {
  h.db.close()
  fs.rmSync(h.root, { recursive: true, force: true })
})

describe('数据库迁移与种子', () => {
  it('迁移幂等：重复执行不会重复应用', () => {
    const config = createConfig()
    const db = new GatewayDatabase(path.join(config.dataDir, 'migrate-test.db'), h.ctx.logger)
    db.migrate()
    db.migrate()
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
    expect(rows.map((row) => Number(row.version))).toEqual([1])
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_tool_audit'").get()).toBeDefined()
    db.close()
    fs.rmSync(path.dirname(config.dataDir), { recursive: true, force: true })
  })

  it('种子幂等：admin/admin123 与 demo/demo123 只创建一次', () => {
    const config = createConfig()
    const db = new GatewayDatabase(path.join(config.dataDir, 'seed-test.db'), h.ctx.logger)
    db.migrate()
    seedDatabase(db, h.ctx.logger)
    seedDatabase(db, h.ctx.logger)
    const count = db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
    expect(Number(count.count)).toBe(2)
    db.close()
    fs.rmSync(path.dirname(config.dataDir), { recursive: true, force: true })
  })
})

describe('会话归属隔离', () => {
  it('普通用户只能读取自己的会话', () => {
    const adminSession = h.ctx.repos.sessions.create({
      id: 'session-admin',
      userId: adminId,
      agentId: 'agent-x',
      agentVersion: 1,
      title: 'admin session',
    })
    const demoSession = h.ctx.repos.sessions.create({
      id: 'session-demo',
      userId: demoId,
      agentId: 'agent-x',
      agentVersion: 1,
      title: 'demo session',
    })

    expect(h.ctx.repos.sessions.getForUser(demoSession.id, demoId, 'user')?.id).toBe('session-demo')
    expect(h.ctx.repos.sessions.getForUser(adminSession.id, demoId, 'user')).toBeUndefined()
    expect(h.ctx.repos.sessions.getForUser(adminSession.id, adminId, 'admin')?.id).toBe('session-admin')

    const demoList = h.ctx.repos.sessions.listForUser(demoId, 'user')
    expect(demoList.map((row) => row.id)).toEqual(['session-demo'])
    const adminList = h.ctx.repos.sessions.listForUser(demoId, 'admin')
    expect(adminList.map((row) => row.id).sort()).toEqual(['session-admin', 'session-demo'])
  })

  it('审批归属沿会话归属过滤', () => {
    const row = h.ctx.repos.approvals.insert({
      sessionId: 'session-admin',
      approvalId: 'approval-1',
      tool: 'query_station',
      description: '查询站点',
      argumentsPreview: '{}',
      argumentsDigest: 'digest',
      expiresAt: Date.now() + 60_000,
    })
    expect(h.ctx.repos.approvals.getForUser(row.id, demoId, 'user')).toBeUndefined()
    expect(h.ctx.repos.approvals.getForUser(row.id, adminId, 'admin')?.id).toBe(row.id)
    expect(h.ctx.repos.approvals.getForUser(row.id, adminId, 'user')?.id).toBe(row.id)
  })
})

describe('Agent 列表归属', () => {
  it('普通用户列表只包含 published', () => {
    const versions = new AgentVersionsRepository(h.db, h.ctx.logger)
    const agents = new AgentsRepository(h.db, h.ctx.logger, versions)
    agents.insert({
      id: 'repo-draft',
      name: 'Repo draft',
      description: '',
      status: 'draft',
      ownerId: adminId,
      currentVersion: 0,
      draft: agentConfigSchema.parse({ id: 'repo-draft', name: 'Repo draft' }),
    })
    agents.insert({
      id: 'repo-published',
      name: 'Repo published',
      description: '',
      status: 'published',
      ownerId: adminId,
      currentVersion: 0,
      draft: agentConfigSchema.parse({ id: 'repo-published', name: 'Repo published' }),
    })
    const ids = agents.listForUser(demoId, 'user').map((record) => record.id)
    expect(ids).toContain('repo-published')
    expect(ids).not.toContain('repo-draft')
  })
})
