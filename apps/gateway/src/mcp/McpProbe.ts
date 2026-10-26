/**
 * MCP 连接探测（`POST /api/mcp-servers/:id/test`、`GET /api/mcp-servers/:id/tools`）。
 *
 * 支持两种传输：
 * - **stdio**：起子进程，换行分隔 JSON-RPC，`initialize` → `notifications/initialized` → `tools/list`；
 * - **streamable-http**：POST JSON-RPC 到端点，响应可能是 `application/json` 或 `text/event-stream`，
 *   若服务端返回 `mcp-session-id` 则后续请求带上。
 *
 * 安全：凭据只在子进程环境 / 请求头里出现，**不写日志、不进响应**；
 * 返回的只有服务器名、协议版本、工具清单与耗时。
 */
import { spawn } from 'node:child_process'
import type { McpProbeResponse, McpToolInfo, McpTransport } from '@agent-studio/shared'
import type { Logger } from '../logger.js'

export interface ProbeTarget {
  id: string
  transport: McpTransport
  command?: string
  args: string[]
  url?: string
  /** 已解析的凭据环境（只进子进程）。 */
  env: Record<string, string>
  /** 已解析的请求头（只进 HTTP 请求）。 */
  headers: Record<string, string>
  timeoutMs: number
}

interface JsonRpcResponse {
  jsonrpc?: string
  id?: number | string | null
  result?: unknown
  error?: { code?: number; message?: string }
}

const CLIENT_INFO = { name: 'agent-service-probe', version: '1.0.0' }
const PROTOCOL_VERSION = '2024-11-05'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从 `tools/list` 结果里提取工具（兼容分页 `nextCursor`）。 */
function extractTools(result: unknown): { tools: McpToolInfo[]; nextCursor?: string } {
  if (result === null || typeof result !== 'object') return { tools: [] }
  const record = result as Record<string, unknown>
  const rawTools = Array.isArray(record.tools) ? record.tools : []
  const tools: McpToolInfo[] = []
  for (const raw of rawTools) {
    if (raw === null || typeof raw !== 'object') continue
    const tool = raw as Record<string, unknown>
    if (typeof tool.name !== 'string' || tool.name.length === 0) continue
    tools.push({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
    })
  }
  return {
    tools,
    ...(typeof record.nextCursor === 'string' ? { nextCursor: record.nextCursor } : {}),
  }
}

/* ------------------------------------------------------------------ stdio */

async function probeStdio(target: ProbeTarget): Promise<McpProbeResponse> {
  const startedAt = Date.now()
  if (target.command === undefined || target.command === '') {
    return fail(target, startedAt, 'stdio 服务器缺少 command')
  }

  return await new Promise<McpProbeResponse>((resolve) => {
    let settled = false
    let buffer = ''
    let stderrTail = ''
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
    let nextId = 1
    let serverName: string | undefined
    let protocolVersion: string | undefined

    const child = spawn(target.command as string, target.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...baseEnv(), ...target.env },
      windowsHide: true,
    })

    const finish = (response: McpProbeResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.stdin?.end()
      } catch {
        /* 已关闭 */
      }
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      resolve(response)
    }

    const timer = setTimeout(
      () => finish(fail(target, startedAt, `探测超时（${target.timeoutMs}ms）`, serverName, protocolVersion)),
      target.timeoutMs,
    )

    const send = (payload: Record<string, unknown>): void => {
      if (child.stdin === null || child.stdin.destroyed) return
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    }

    const call = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++
      return new Promise<unknown>((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall })
        send({ jsonrpc: '2.0', id, method, params })
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (line === '') continue
        let message: JsonRpcResponse
        try {
          message = JSON.parse(line) as JsonRpcResponse
        } catch {
          continue
        }
        if (typeof message.id !== 'number') continue
        const waiter = pending.get(message.id)
        if (waiter === undefined) continue
        pending.delete(message.id)
        if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? `JSON-RPC 错误 ${String(message.error.code)}`))
        else waiter.resolve(message.result)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-800)
    })
    child.on('error', (error) => finish(fail(target, startedAt, `无法启动服务器: ${error.message}`)))
    child.on('exit', (code) => {
      if (!settled) {
        finish(fail(target, startedAt, `服务器提前退出（code ${String(code)}）${stderrTail === '' ? '' : `：${stderrTail.slice(-300)}`}`))
      }
    })

    void (async () => {
      try {
        const init = (await call('initialize', {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        })) as Record<string, unknown> | undefined
        protocolVersion = typeof init?.protocolVersion === 'string' ? init.protocolVersion : undefined
        const serverInfo = init?.serverInfo
        if (serverInfo !== null && typeof serverInfo === 'object') {
          const name = (serverInfo as Record<string, unknown>).name
          if (typeof name === 'string') serverName = name
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })

        const collected: McpToolInfo[] = []
        let cursor: string | undefined
        for (let page = 0; page < 10; page += 1) {
          const listed = await call('tools/list', cursor === undefined ? {} : { cursor })
          const pageResult = extractTools(listed)
          collected.push(...pageResult.tools)
          cursor = pageResult.nextCursor
          if (cursor === undefined) break
        }
        finish({
          ok: true,
          serverId: target.id,
          ...(serverName === undefined ? {} : { serverName }),
          ...(protocolVersion === undefined ? {} : { protocolVersion }),
          tools: collected,
          durationMs: Date.now() - startedAt,
          transport: 'stdio',
        })
      } catch (error) {
        finish(fail(target, startedAt, errorMessage(error), serverName, protocolVersion))
      }
    })()
  })
}

/* --------------------------------------------------------- streamable-http */

async function probeHttp(target: ProbeTarget): Promise<McpProbeResponse> {
  const startedAt = Date.now()
  if (target.url === undefined || target.url === '') {
    return fail(target, startedAt, 'streamable-http 服务器缺少 url')
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), target.timeoutMs)
  let sessionId: string | undefined
  let nextId = 1

  const call = async (method: string, params: unknown): Promise<unknown> => {
    const response = await fetch(target.url as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        ...target.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
      signal: controller.signal,
    })
    const returnedSession = response.headers.get('mcp-session-id')
    if (returnedSession !== null) sessionId = returnedSession
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${await safeText(response)}`)
    }
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      return await readSseResult(response, nextId - 1)
    }
    const payload = (await response.json()) as JsonRpcResponse
    if (payload.error !== undefined) throw new Error(payload.error.message ?? 'JSON-RPC 错误')
    return payload.result
  }

  try {
    const init = (await call('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as Record<string, unknown> | undefined
    const serverInfo = init?.serverInfo
    const serverName =
      serverInfo !== null && typeof serverInfo === 'object' && typeof (serverInfo as Record<string, unknown>).name === 'string'
        ? ((serverInfo as Record<string, unknown>).name as string)
        : undefined
    const protocolVersion = typeof init?.protocolVersion === 'string' ? init.protocolVersion : undefined
    // 通知不需要响应；失败也不影响列工具。
    await fetch(target.url as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        ...target.headers,
      },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: controller.signal,
    }).catch(() => undefined)

    const collected: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const listed = await call('tools/list', cursor === undefined ? {} : { cursor })
      const pageResult = extractTools(listed)
      collected.push(...pageResult.tools)
      cursor = pageResult.nextCursor
      if (cursor === undefined) break
    }
    return {
      ok: true,
      serverId: target.id,
      ...(serverName === undefined ? {} : { serverName }),
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      tools: collected,
      durationMs: Date.now() - startedAt,
      transport: 'streamable-http',
    }
  } catch (error) {
    return fail(target, startedAt, errorMessage(error), undefined, undefined)
  } finally {
    clearTimeout(timer)
  }
}

/** 从 SSE 响应里取最后一条匹配 id 的 JSON-RPC 结果。 */
async function readSseResult(response: Response, expectedId: number): Promise<unknown> {
  const text = await response.text()
  let result: unknown
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const message = JSON.parse(payload) as JsonRpcResponse
      if (message.id !== expectedId) continue
      if (message.error !== undefined) throw new Error(message.error.message ?? 'JSON-RPC 错误')
      result = message.result
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('JSON')) continue
      throw error
    }
  }
  return result
}

async function safeText(response: Response): Promise<string> {
  try {
    const text = await response.text()
    return text.trim() === '' ? '' : `：${text.slice(0, 300)}`
  } catch {
    return ''
  }
}

/* ------------------------------------------------------------------ 公共 */

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }
  for (const key of ['SYSTEMROOT', 'WINDIR', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function fail(
  target: ProbeTarget,
  startedAt: number,
  error: string,
  serverName?: string,
  protocolVersion?: string,
): McpProbeResponse {
  return {
    ok: false,
    serverId: target.id,
    ...(serverName === undefined ? {} : { serverName }),
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    tools: [],
    durationMs: Date.now() - startedAt,
    error,
    transport: target.transport,
  }
}

/** 按传输类型探测。 */
export async function probeMcpServer(target: ProbeTarget, logger?: Logger): Promise<McpProbeResponse> {
  logger?.info('mcp probe started', { serverId: target.id, transport: target.transport })
  const result = target.transport === 'stdio' ? await probeStdio(target) : await probeHttp(target)
  if (result.ok) {
    logger?.info('mcp probe succeeded', {
      serverId: target.id,
      tools: result.tools.length,
      durationMs: result.durationMs,
    })
  } else {
    logger?.warn('mcp probe failed', { serverId: target.id, error: result.error })
  }
  return result
}
