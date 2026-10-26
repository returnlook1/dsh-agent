import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { agentConfigSchema } from '@agent-studio/shared'
import { auth, createHarness, login, type TestHarness } from '../helpers.js'
import { issueToken, verifyToken } from '../../src/auth/tokens.js'

let h: TestHarness
let adminToken: string
let demoToken: string

beforeAll(async () => {
  h = await createHarness()
  adminToken = await login(h.app, 'admin', 'admin123')
  demoToken = await login(h.app, 'demo', 'demo123')
})

afterAll(async () => {
  await h.close()
})

describe('POST /api/auth/login', () => {
  it('管理员登录成功并返回用户与过期时间', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { token: string; user: { username: string; role: string }; expiresAt: number }
    expect(body.token.split('.')).toHaveLength(2)
    expect(body.user).toMatchObject({ username: 'admin', role: 'admin' })
    expect(body.expiresAt).toBeGreaterThan(Date.now())
  })

  it('密码错误返回 401 UNAUTHORIZED', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'wrong-password' },
    })
    expect(response.statusCode).toBe(401)
    expect((response.json() as { error: { code: string } }).error.code).toBe('UNAUTHORIZED')
  })

  it('不存在的用户同样返回 401（不泄露账号是否存在）', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'whatever' },
    })
    expect(response.statusCode).toBe(401)
  })
})

describe('令牌校验', () => {
  it('过期令牌被拒绝', () => {
    const issued = issueToken({ id: 'u1', role: 'user' }, 'secret', -1_000, Date.now() - 10_000)
    expect(verifyToken(issued.token, 'secret')).toBeUndefined()
  })

  it('签名错误被拒绝；篡改载荷被拒绝', () => {
    const issued = issueToken({ id: 'u1', role: 'user' }, 'secret', 60_000)
    expect(verifyToken(issued.token, 'other-secret')).toBeUndefined()
    const [, signature] = issued.token.split('.')
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'admin', role: 'admin', exp: Date.now() + 60_000, iat: Date.now() })).toString('base64url')
    expect(verifyToken(`${forgedPayload}.${signature}`, 'secret')).toBeUndefined()
  })

  it('无令牌访问受保护接口返回 401', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/agents' })
    expect(response.statusCode).toBe(401)
  })
})

describe('角色隔离', () => {
  it('user 不能创建 Agent / 看审计', async () => {
    const create = await h.app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: auth(demoToken),
      payload: { name: 'Forbidden Agent' },
    })
    expect(create.statusCode).toBe(403)

    const audit = await h.app.inject({ method: 'GET', url: '/api/audit/tool-calls', headers: auth(demoToken) })
    expect(audit.statusCode).toBe(403)
  })

  it('user 只看到 published 的 Agent，草稿对非 owner 不可见', async () => {
    const adminUser = h.ctx.repos.users.findByUsername('admin')
    const demoUser = h.ctx.repos.users.findByUsername('demo')
    expect(adminUser).toBeDefined()
    expect(demoUser).toBeDefined()

    const draft = h.ctx.repos.agents.insert({
      id: 'draft-agent',
      name: 'Draft Agent',
      description: '',
      status: 'draft',
      ownerId: adminUser?.id ?? 'admin',
      currentVersion: 0,
      draft: agentConfigSchema.parse({ id: 'draft-agent', name: 'Draft Agent' }),
    })
    expect(draft.status).toBe('draft')

    h.ctx.repos.agents.insert({
      id: 'published-agent',
      name: 'Published Agent',
      description: '',
      status: 'published',
      ownerId: adminUser?.id ?? 'admin',
      currentVersion: 0,
      draft: agentConfigSchema.parse({ id: 'published-agent', name: 'Published Agent' }),
    })

    const list = await h.app.inject({ method: 'GET', url: '/api/agents', headers: auth(demoToken) })
    expect(list.statusCode).toBe(200)
    const items = (list.json() as { items: Array<{ id: string }> }).items
    expect(items.map((item) => item.id)).toContain('published-agent')
    expect(items.map((item) => item.id)).not.toContain('draft-agent')

    const hidden = await h.app.inject({ method: 'GET', url: '/api/agents/draft-agent', headers: auth(demoToken) })
    expect(hidden.statusCode).toBe(404)

    const adminList = await h.app.inject({ method: 'GET', url: '/api/agents', headers: auth(adminToken) })
    expect(adminList.statusCode).toBe(200)
    const adminIds = (adminList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)
    expect(adminIds).toContain('draft-agent')
  })

  it('审计接口返回空分页结构', async () => {
    const response = await h.app.inject({
      method: 'GET',
      url: '/api/audit/tool-calls?limit=10&offset=0',
      headers: auth(adminToken),
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ total: 0, items: [] })
  })
})

describe('健康检查', () => {
  it('公开可用且数据库正常', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/health' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as { ok: boolean; database: string; dshVersion: string }
    expect(body.ok).toBe(true)
    expect(body.database).toBe('ok')
    expect(body.dshVersion).toBe('0.2.1-rc.3')
  })
})
