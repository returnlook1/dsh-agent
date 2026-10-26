#!/usr/bin/env node
/**
 * 本地 mock LLM 服务（仅开发/演示用）。
 *
 * 让整套平台在没有 API Key、没有外网的环境下跑通：把网关的
 * `DEEPSEEK_BASE_URL` 指向本服务即可。
 *
 * 行为脚本（循环）：第 1 次请求返回一次 `query_station` 工具调用，第 2 次返回文本结论，
 * 之后一直返回文本结论。想换工具调用，改下面的 `TOOL_*` 常量或加参数。
 *
 * 用法：
 *   node scripts/mock-llm-server.mjs                 # 默认 127.0.0.1:8899
 *   node scripts/mock-llm-server.mjs --port 9000
 *   node scripts/mock-llm-server.mjs --tool export_report --args '{"stationId":"ST-3101","format":"pdf"}'
 *
 * 然后在另一个终端：
 *   $env:MOCK_LLM='1'
 *   $env:DEEPSEEK_API_KEY='mock-key'
 *   $env:DEEPSEEK_BASE_URL='http://127.0.0.1:8899/v1'
 *   npm start
 */
import process from 'node:process'

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const port = Number(typeof args.port === 'string' ? args.port : 8899)
const host = typeof args.host === 'string' ? args.host : '127.0.0.1'
const toolName = typeof args.tool === 'string' ? args.tool : 'query_station'
const toolArguments =
  typeof args.args === 'string' ? args.args : '{"stationId":"ST-3101","days":7}'

const { startMockLlmServer } = await import('@deepseek-ai/dsh-llm-mock-server')
const { DEMO_ANSWER_MARKDOWN } = await import('./demo-answer.mjs')

const server = await startMockLlmServer({
  host,
  port,
  apiKey: process.env.MOCK_LLM_API_KEY,
  sequence: ['tool_call_success', 'success'],
  repeatLast: true,
  successText: DEMO_ANSWER_MARKDOWN,
  toolName,
  toolArguments,
})

process.stdout.write(
  [
    `mock LLM 已启动：${server.baseURL}`,
    `  endpoint: ${server.baseURL}/v1/messages`,
    `  第一次请求会要求调用工具 ${toolName}，之后返回文本结论`,
    '',
    '在另一个终端设置：',
    `  $env:DEEPSEEK_BASE_URL='${server.baseURL}/v1'`,
    "  $env:DEEPSEEK_API_KEY='mock-key'",
    "  $env:MOCK_LLM='1'",
    '',
    '按 Ctrl+C 退出。',
    '',
  ].join('\n'),
)

const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
