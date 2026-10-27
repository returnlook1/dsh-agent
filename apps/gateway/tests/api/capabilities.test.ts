/**
 * 能力来源与在线管理：
 * - `/api/capabilities/sources` 描述技能根目录 / MCP 配置；
 * - `POST /api/skills` 新建技能（写 SKILL.md）；
 * - `PUT/DELETE /api/mcp-servers/:id` 写回 config/mcp-servers.json（凭据保留 `${ENV}` 引用）；
 * - 本地动作开关关闭时 `reveal` 返回 403；
 * - `/api/dsh-app` 返回唤起 DSH 的深链。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {
  CapabilitySourcesResponse,
  CreateSkillResponse,
  DshAppResponse,
  McpServerListResponse,
  UpsertMcpServerResponse,
} from '@agent-studio/shared'

import { createHarness, type TestHarness } from '../helpers.js'

let h: TestHarness

beforeAll(async () => {
  h = await createHarness({
    skills: [{ name: 'netcdf-analysis', description: '分析 NetCDF', bundle: true }],
    overrides: { allowLocalActions: false },
  })
})

afterAll(async () => {
  await h.close()
})

describe('GET /api/capabilities/sources', () => {
  it('列出技能根目录、MCP 配置与本地动作状态', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/capabilities/sources' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as CapabilitySourcesResponse
    expect(body.skills.total).toBeGreaterThanOrEqual(1)
    expect(body.skills.roots[0]?.path).toBe(h.skillsDir)
    expect(body.skills.roots[0]?.writable).toBe(true)
    expect(body.skills.writableRoot).toBe(h.skillsDir)
    expect(body.mcp.configPath).toBe(h.mcpConfigPath)
    expect(body.mcp.exists).toBe(true)
    expect(body.actions.enabled).toBe(false)
  })
})

describe('POST /api/skills', () => {
  it('写入 SKILL.md 并出现在技能清单里', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: {
        name: 'water-quality',
        description: '水质类别判定',
        whenToUse: '需要按溶解氧判定水质类别时',
      },
    })
    expect(response.statusCode).toBe(201)
    const created = (response.json() as CreateSkillResponse).skill
    expect(created.name).toBe('water-quality')
    expect(created.description).toBe('水质类别判定')

    const file = path.join(h.skillsDir, 'water-quality', 'SKILL.md')
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw.startsWith('---')).toBe(true)
    expect(raw).toContain('name: water-quality')
    expect(raw).toContain('whenToUse: 需要按溶解氧判定水质类别时')

    const list = await h.app.inject({ method: 'GET', url: '/api/skills' })
    const names = (list.json() as { skills: Array<{ name: string }> }).skills.map((skill) => skill.name)
    expect(names).toContain('water-quality')
  })

  it('重名 → 409', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: { name: 'water-quality', description: '重复' },
    })
    expect(response.statusCode).toBe(409)
    expect((response.json() as { error: { code: string } }).error.code).toBe('CONFLICT')
  })

  it('非法名字 → 400', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/skills',
      payload: { name: 'Bad Name!', description: 'x' },
    })
    expect(response.statusCode).toBe(400)
    expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_ERROR')
  })

  it('DELETE 可删除刚创建的技能', async () => {
    const response = await h.app.inject({ method: 'DELETE', url: '/api/skills/water-quality' })
    expect(response.statusCode).toBe(204)
    expect(fs.existsSync(path.join(h.skillsDir, 'water-quality'))).toBe(false)
  })
})

describe('PUT /api/mcp-servers/:id', () => {
  it('新增定义写入配置文件，凭据保持 ${ENV} 引用', async () => {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/api/mcp-servers/water',
      payload: {
        name: '水质服务',
        transport: 'stdio',
        command: 'node',
        args: ['./water.mjs'],
        env: { WATER_TOKEN: '${WATER_TOKEN}' },
      },
    })
    expect(response.statusCode).toBe(200)
    const server = (response.json() as UpsertMcpServerResponse).server
    expect(server.id).toBe('water')
    expect(server.env.WATER_TOKEN).toBe('${WATER_TOKEN}')

    const file = JSON.parse(fs.readFileSync(h.mcpConfigPath, 'utf8')) as {
      servers: Array<{ id: string; env: Record<string, string> }>
    }
    expect(file.servers.map((entry) => entry.id)).toEqual(['water'])
    expect(file.servers[0]?.env.WATER_TOKEN).toBe('${WATER_TOKEN}')
  })

  it('修改同 id 是覆盖而不是追加', async () => {
    await h.app.inject({
      method: 'PUT',
      url: '/api/mcp-servers/water',
      payload: { name: '水质服务 v2', transport: 'streamable-http', url: 'http://127.0.0.1:9200/mcp' },
    })
    const file = JSON.parse(fs.readFileSync(h.mcpConfigPath, 'utf8')) as {
      servers: Array<{ id: string; name: string }>
    }
    expect(file.servers).toHaveLength(1)
    expect(file.servers[0]?.name).toBe('水质服务 v2')
  })

  it('不合法定义 → 400', async () => {
    const response = await h.app.inject({
      method: 'PUT',
      url: '/api/mcp-servers/water',
      payload: { name: '缺少 url', transport: 'streamable-http' },
    })
    // 定义允许为空 url（配置层会报错），但 transport 枚举之外的会 400
    const badTransport = await h.app.inject({
      method: 'PUT',
      url: '/api/mcp-servers/water2',
      payload: { name: 'x', transport: 'grpc' },
    })
    expect(badTransport.statusCode).toBe(400)
    expect(response.statusCode).toBe(200)
  })

  it('DELETE 删除本地定义', async () => {
    const response = await h.app.inject({ method: 'DELETE', url: '/api/mcp-servers/water' })
    expect(response.statusCode).toBe(204)
    const list = await h.app.inject({ method: 'GET', url: '/api/mcp-servers' })
    const ids = (list.json() as McpServerListResponse).servers.map((server) => server.id)
    expect(ids).not.toContain('water')
  })
})

describe('本地动作与 DSH 唤起', () => {
  it('关闭本地动作时 reveal → 403', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/api/capabilities/reveal',
      payload: { target: 'skills' },
    })
    expect(response.statusCode).toBe(403)
    expect((response.json() as { error: { code: string } }).error.code).toBe('LOCAL_ACTIONS_DISABLED')
  })

  it('GET /api/dsh-app 返回深链与可达性', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/dsh-app' })
    expect(response.statusCode).toBe(200)
    const body = response.json() as DshAppResponse
    expect(body.deepLink).toBe('dsh://open')
    expect(typeof body.guiReachable).toBe('boolean')
    expect(body.checkedAt).toBeGreaterThan(0)
  })
})
