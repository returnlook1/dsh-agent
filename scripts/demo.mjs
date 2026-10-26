#!/usr/bin/env node
/**
 * 一条命令启动整套 Playground（服务 + 本地 mock 模型）。
 *
 * 适合演示与本地联调：进程内起 mock 模型，再拉起 Agent Service，按 Ctrl+C 一起退出。
 *
 *   node scripts/demo.mjs                 # 离线模式（mock 模型，无需 API Key）
 *   node scripts/demo.mjs --port 9000
 *   node scripts/demo.mjs --live          # 用真实模型（需要 DEEPSEEK_API_KEY）
 *   node scripts/demo.mjs --no-open       # 不自动打开浏览器
 *
 * 生产部署请直接用 `npm start`，不要用这个脚本（它会起 mock 模型）。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

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
const live = args.live === true
const port = Number(typeof args.port === 'string' ? args.port : 8787)
const shouldOpen = args['no-open'] !== true
const baseUrl = `http://127.0.0.1:${port}`

const serverEntry = path.join(root, 'apps', 'gateway', 'dist', 'server.js')
if (!existsSync(serverEntry)) {
  console.error(
    '未找到构建产物 apps/gateway/dist/server.js。\n先运行：npm run build',
  )
  process.exit(1)
}
if (!existsSync(path.join(root, 'apps', 'web', 'dist', 'index.html'))) {
  console.error('未找到前端产物 apps/web/dist。先运行：npm run build:web')
  process.exit(1)
}

const skillsDir = path.join(root, 'runtime', 'skills')
if (!existsSync(skillsDir)) {
  console.error(`未找到技能目录 ${skillsDir}`)
  process.exit(1)
}

/** @type {{ baseURL: string, close: () => Promise<void> } | undefined} */
let mock
const env = {
  ...process.env,
  PORT: String(port),
  HOST: '127.0.0.1',
  SKILLS_DIRS: skillsDir,
  MCP_CONFIG: path.join(root, 'config', 'mcp-servers.json'),
  AGENT_SERVICE_TOOLS_DATA_DIR: path.join(root, 'runtime', 'tools'),
  WEB_DIST: path.join(root, 'apps', 'web', 'dist'),
  AGENT_SERVICE_DSH_PROFILE: 'agent-service',
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
}
// 宿主（DSH Desktop）的这两个变量会污染运行时选择，必须清掉
delete env.DSH_PROFILE
delete env.DSH_HOME

if (live) {
  if (process.env.DEEPSEEK_API_KEY === undefined || process.env.DEEPSEEK_API_KEY === '') {
    console.error('--live 需要先设置 DEEPSEEK_API_KEY')
    process.exit(1)
  }
  console.log('[demo] 真实模型模式：使用 DEEPSEEK_API_KEY 调用模型')
} else {
  const { startMockLlmServer } = await import('@deepseek-ai/dsh-llm-mock-server')
  mock = await startMockLlmServer({
    port: 8899,
    apiKey: 'mock-key',
    // 每个进程只脚本化"一次工具调用 + 一段结论"；之后的轮次只返回文本
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: '已完成。这是一段来自本地 mock 模型的示例回答。',
    // 默认演示「技能加载」：项目默认配置里已经选中了这些技能（见下面的种子数据）
    toolName: 'skill',
    toolArguments: JSON.stringify({ name: 'netcdf-analysis' }),
  })
  Object.assign(env, {
    MOCK_LLM: '1',
    DEEPSEEK_API_KEY: 'mock-key',
    DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
  })
  console.log(`[demo] 离线模式：mock 模型 ${mock.baseURL}`)
}

const child = spawn(process.execPath, [serverEntry], { env, cwd: root, stdio: 'inherit' })

let shuttingDown = false
async function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  child.kill()
  if (mock) await mock.close().catch(() => undefined)
  process.exit(code)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
child.on('exit', (code) => void shutdown(code ?? 0))

// 等服务起来再打印地址
const deadline = Date.now() + 60_000
let ready = false
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${baseUrl}/api/health`)
    if (response.ok) {
      ready = true
      break
    }
  } catch {
    /* 还没起来 */
  }
  await new Promise((resolve) => setTimeout(resolve, 400))
}

if (!ready) {
  console.error('[demo] 服务 60s 内未就绪，请检查上面的日志')
  await shutdown(1)
}

// 给默认项目种一份能立刻演示的能力配置（首次启动时生效；已保存过则跳过）
try {
  const existing = await fetch(`${baseUrl}/api/projects/default/agent-config`)
  const body = await existing.json()
  if (body?.saved !== true) {
    await fetch(`${baseUrl}/api/projects/default/agent-config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: ['netcdf-analysis', 'gis-processing'],
        mcpServers: ['data-center'],
        // provider/model 由 DSH 决定，演示项目只种能力与提示词
        systemPrompt: '你是海洋环境分析助手。回答时先给结论，再给依据；不确定的数据要说明。',
      }),
    })
    console.log('[demo] 已为项目 default 写入演示配置（Skills + MCP）')
  }
} catch {
  console.log('[demo] 项目默认配置未写入（可忽略，界面上手动选择即可）')
}

console.log('')
console.log(`[demo] Agent Playground: ${baseUrl}`)
console.log('[demo] 左侧选择项目 / Skills / MCP → 新建对话 → 发消息')
console.log('[demo] 按 Ctrl+C 退出')
console.log('')

if (shouldOpen) {
  const command =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', baseUrl]] : process.platform === 'darwin' ? ['open', [baseUrl]] : ['xdg-open', [baseUrl]]
  try {
    spawn(command[0], command[1], { stdio: 'ignore', detached: true }).unref()
  } catch {
    /* 打不开就让用户自己点链接 */
  }
}
