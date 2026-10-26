/**
 * 静态前端托管与 SPA 路由回退。
 *
 * 前端是 Vue Router 的 history 模式：直接访问 `/agents/:id/edit` 或刷新聊天页时，
 * 网关必须回退到 `index.html`，否则部署后一刷新就 404。同时不能把这条回退
 * 扩大到 API 或缺失的静态资源上（否则会把配置错误伪装成 200）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createConfig, createHarness, type TestHarness } from '../helpers.js'

let h: TestHarness
let webDist: string

beforeAll(async () => {
  webDist = path.join(createConfig().dataDir, '..', 'web-dist')
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true })
  fs.writeFileSync(
    path.join(webDist, 'index.html'),
    '<!doctype html><html><body><div id="app-marker">Agent Studio</div></body></html>',
    'utf8',
  )
  fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log("ok")\n', 'utf8')
  h = await createHarness({ webDist })
})

afterAll(async () => {
  await h.close()
})

const htmlHeaders = { accept: 'text/html,application/xhtml+xml' }

describe('静态前端与 SPA 回退', () => {
  it('根路径返回 index.html', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/', headers: htmlHeaders })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('app-marker')
    expect(response.headers['content-type']).toContain('text/html')
  })

  it('前端路由直接访问时回退到 index.html', async () => {
    for (const url of ['/agents', '/agents/demo/edit', '/chat/demo', '/mcp', '/audit']) {
      const response = await h.app.inject({ method: 'GET', url, headers: htmlHeaders })
      expect(response.statusCode, url).toBe(200)
      expect(response.body, url).toContain('app-marker')
    }
  })

  it('静态资源按真实文件返回', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/assets/app.js' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('console.log')
  })

  it('缺失的静态资源仍然 404，而不是回退成页面', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/assets/missing.js', headers: htmlHeaders })
    expect(response.statusCode).toBe(404)
  })

  it('API 的未知路由保持 JSON 404', async () => {
    const response = await h.app.inject({ method: 'GET', url: '/api/unknown', headers: htmlHeaders })
    expect(response.statusCode).toBe(404)
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND')
  })

  it('非 GET 请求不回退到页面', async () => {
    const response = await h.app.inject({
      method: 'POST',
      url: '/agents/demo/edit',
      headers: htmlHeaders,
      payload: {},
    })
    expect(response.statusCode).toBe(404)
  })

  it('未配置 webDist 时不做回退', async () => {
    const bare = await createHarness({ webDist: undefined })
    try {
      const response = await bare.app.inject({ method: 'GET', url: '/agents', headers: htmlHeaders })
      expect(response.statusCode).toBe(404)
    } finally {
      await bare.close()
    }
  })
})
