/**
 * 最小 stdio MCP 探测客户端：只做 `initialize` + `tools/list`，用于连通性测试
 * 与工具发现。SSE/HTTP 传输第一版不实现（返回明确错误）。
 *
 * 安全：环境变量只注入 `config.envKeys` 白名单里的键，值来自网关进程环境，
 * 绝不把整个父环境交给 MCP 子进程。
 */
import { spawn } from 'node:child_process'
import type { McpServerConfig } from '@agent-studio/shared'

export interface McpProbeTool {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpProbeResult {
  ok: boolean
  tools: McpProbeTool[]
  serverInfo?: { name?: string; version?: string }
  error?: string
}

export interface McpProbeOptions {
  timeoutMs?: number
}

interface JsonRpcResponse {
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string }
}

function buildEnv(config: McpServerConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of config.envKeys) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  // PATH 是启动可执行文件的必要条件；不含任何凭据。
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH
  if (process.env.SYSTEMROOT !== undefined) env.SYSTEMROOT = process.env.SYSTEMROOT
  return env
}

export async function probeMcpServer(
  config: McpServerConfig,
  options: McpProbeOptions = {},
): Promise<McpProbeResult> {
  if (config.transport !== 'stdio') {
    return { ok: false, tools: [], error: `transport "${config.transport}" 尚未实现，第一版仅支持 stdio` }
  }
  if (config.command === undefined || config.command === '') {
    return { ok: false, tools: [], error: 'stdio MCP 服务器缺少 command' }
  }

  const timeoutMs = options.timeoutMs ?? 10_000

  return await new Promise<McpProbeResult>((resolve) => {
    let settled = false
    let buffer = ''
    const pending = new Map<number, (response: JsonRpcResponse) => void>()
    let nextId = 1

    const child = spawn(config.command as string, config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildEnv(config),
      windowsHide: true,
    })

    const finish = (result: McpProbeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        // 进程可能已经退出。
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish({ ok: false, tools: [], error: `MCP probe timed out after ${timeoutMs}ms` }), timeoutMs)

    const send = (payload: Record<string, unknown>): void => {
      if (child.stdin === null) return
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    }

    const request = (method: string, params: Record<string, unknown>): Promise<JsonRpcResponse> => {
      const id = nextId++
      return new Promise((resolveRequest) => {
        pending.set(id, resolveRequest)
        send({ jsonrpc: '2.0', id, method, params })
      })
    }

    child.on('error', (error) => finish({ ok: false, tools: [], error: `spawn failed: ${error.message}` }))
    child.stderr?.on('data', () => {
      // 丢弃 MCP 服务器 stderr，避免污染网关日志；出错时由 JSON-RPC 错误体现。
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line === '') continue
        let message: JsonRpcResponse
        try {
          message = JSON.parse(line) as JsonRpcResponse
        } catch {
          continue
        }
        if (typeof message.id === 'number' && pending.has(message.id)) {
          const resolveRequest = pending.get(message.id) as (response: JsonRpcResponse) => void
          pending.delete(message.id)
          resolveRequest(message)
        }
      }
    })

    void (async () => {
      try {
        const initialized = await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'agent-studio-gateway', version: '1.0.0' },
        })
        if (initialized.error !== undefined) {
          finish({ ok: false, tools: [], error: initialized.error.message ?? 'initialize failed' })
          return
        }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        const listed = await request('tools/list', {})
        if (listed.error !== undefined) {
          finish({ ok: false, tools: [], error: listed.error.message ?? 'tools/list failed' })
          return
        }
        const result = listed.result as { tools?: unknown } | undefined
        const rawTools = Array.isArray(result?.tools) ? result.tools : []
        const tools: McpProbeTool[] = []
        for (const entry of rawTools) {
          if (typeof entry !== 'object' || entry === null) continue
          const record = entry as Record<string, unknown>
          if (typeof record.name !== 'string') continue
          const tool: McpProbeTool = { name: record.name }
          if (typeof record.description === 'string') tool.description = record.description
          if (record.inputSchema !== undefined) tool.inputSchema = record.inputSchema
          tools.push(tool)
        }
        const info = initialized.result as { serverInfo?: { name?: string; version?: string } } | undefined
        finish({ ok: true, tools, ...(info?.serverInfo === undefined ? {} : { serverInfo: info.serverInfo }) })
      } catch (error) {
        finish({ ok: false, tools: [], error: error instanceof Error ? error.message : String(error) })
      }
    })()
  })
}
