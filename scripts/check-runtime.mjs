#!/usr/bin/env node
/**
 * 运行时层验证（不经过 HTTP 服务）：确认 `agent-service` profile 的三条关键能力。
 *
 *   1. skill       —— 模型能调用被选中的 Skill（skills-view 里有它）
 *   2. skill-hidden —— 未选中的 Skill 对模型不可见（调用会失败）
 *   3. mcp         —— 被选中的 MCP 服务器工具可以被调用（`mcp__data-center__*`）
 *
 * 它按 Agent Service 的方式物化快照（同样从 runtime/templates/agent-service 复制），
 * 用进程内 mock 模型驱动真实 DSH 子进程，因此不需要 API Key、不联网。
 *
 * 用法：
 *   node scripts/check-runtime.mjs            # 跑全部场景
 *   node scripts/check-runtime.mjs --only mcp
 *   node scripts/check-runtime.mjs --keep     # 保留快照目录
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const onlyIndex = args.indexOf('--only')
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : undefined

const SKILLS_SOURCE = path.join(root, 'runtime', 'skills')
const TEMPLATE_DIR = path.join(root, 'runtime', 'templates', 'agent-service')
const TOOLS_PLUGIN = path.join(root, 'plugins', 'agent-tools', 'dist', 'index.js')
const MCP_SERVER = path.join(root, 'scripts', 'mcp-data-center-server.mjs')

const failures = []
let assertions = 0

function log(message) {
  process.stdout.write(`${message}\n`)
}

function check(name, condition, detail) {
  assertions += 1
  if (condition) {
    log(`  ✓ ${name}`)
  } else {
    failures.push(detail === undefined ? name : `${name}: ${detail}`)
    log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 与服务的 SkillSource 等价：在技能根目录里找到某个技能（目录 bundle 或单文件）。 */
function findSkillSource(name) {
  if (!existsSync(SKILLS_SOURCE)) return undefined
  const direct = path.join(SKILLS_SOURCE, name)
  if (existsSync(direct) && statSync(direct).isDirectory()) {
    return existsSync(path.join(direct, 'SKILL.md')) ? { kind: 'bundle', path: direct } : undefined
  }
  const flat = path.join(SKILLS_SOURCE, `${name}.md`)
  if (existsSync(flat)) return { kind: 'file', path: flat }
  const entries = readdirSync(SKILLS_SOURCE, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(SKILLS_SOURCE, entry.name, 'SKILL.md')
    if (!existsSync(skillFile)) continue
    const text = readFileSync(skillFile, 'utf8')
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    const declared = match === null ? entry.name : /(^|\n)name:\s*(.+)/.exec(match[1])?.[2]?.trim() ?? entry.name
    if (declared === name) return { kind: 'bundle', path: path.join(SKILLS_SOURCE, entry.name) }
  }
  return undefined
}

/** 物化一个快照（与服务 SnapshotMaterializer 的最终布局一致）。 */
function materialize(snapshotId, skills, mcpServers) {
  const snapRoot = path.join(root, '.tmp', 'runtime-check', snapshotId)
  const homeDir = path.join(snapRoot, 'home')
  const profileDir = path.join(homeDir, 'profiles', 'agent-service')
  const skillsView = path.join(snapRoot, 'skills-view')
  const workspace = path.join(snapRoot, 'workspace')
  const patchDir = path.join(snapRoot, 'patches')
  for (const dir of [profileDir, skillsView, workspace, patchDir, path.join(workspace, '.studio', 'data')]) {
    mkdirSync(dir, { recursive: true })
  }

  // 只复制被选中的技能
  for (const name of skills) {
    const source = findSkillSource(name)
    if (source === undefined) throw new Error(`未知技能 ${name}`)
    const target = path.join(skillsView, name)
    if (source.kind === 'bundle') {
      cpSync(source.path, target, { recursive: true })
    } else {
      cpSync(source.path, path.join(skillsView, `${name}.md`))
    }
  }

  const patch = readFileSync(path.join(TEMPLATE_DIR, 'cordis.patch.yml'), 'utf8')
    .replaceAll('{{SKILLS_VIEW}}', skillsView.replaceAll('\\', '/'))
    .replaceAll('{{WORKSPACE}}', workspace.replaceAll('\\', '/'))
    .replaceAll('{{TOOLS_PLUGIN}}', TOOLS_PLUGIN.replaceAll('\\', '/'))
  writeFileSync(path.join(profileDir, 'package.json'), readFileSync(path.join(TEMPLATE_DIR, 'package.json'), 'utf8'), 'utf8')
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), patch, 'utf8')
  writeFileSync(path.join(homeDir, 'cordis.patch.yml'), '[]\n', 'utf8')

  // 系统提示词覆盖层
  writeFileSync(
    path.join(patchDir, 'agent.cordis.yml'),
    `- id: system-prompt\n  config:\n    includeHarnessIdentity: false\n    includeRuntimeContext: false\n    personaPrefix: ${JSON.stringify('你是海洋环境分析助手，只能使用已授权的技能与工具。')}\n`,
    'utf8',
  )

  // MCP 覆盖层
  const entries = mcpServers
    .map(
      (serverName) => `    - id: mcp-client-${serverName}
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: ${JSON.stringify(serverName)}
        command: ${JSON.stringify(process.execPath)}
        args: [${JSON.stringify(MCP_SERVER.replaceAll('\\', '/'))}]
        env: {}
        cwd: ${JSON.stringify(workspace.replaceAll('\\', '/'))}
        toolCallTimeoutMs: 30000
        failOnStartupError: false
`,
    )
    .join('')
  writeFileSync(path.join(patchDir, 'mcp.cordis.yml'), mcpServers.length === 0 ? '[]\n' : `- insert:\n${entries}`, 'utf8')

  // 业务工具数据
  const toolsData = path.join(root, 'runtime', 'tools')
  if (existsSync(toolsData)) {
    for (const file of readdirSync(toolsData)) {
      cpSync(path.join(toolsData, file), path.join(workspace, '.studio', 'data', file))
    }
  }

  return {
    snapRoot,
    homeDir,
    workspace,
    patches: [path.join(patchDir, 'agent.cordis.yml'), path.join(patchDir, 'mcp.cordis.yml')],
  }
}

async function runScenario(scenario) {
  log('')
  log(`=== 场景 ${scenario.name}：${scenario.description} ===`)
  const snapshot = materialize(`snap-${Date.now().toString(36)}`, scenario.skills, scenario.mcpServers)

  const { startMockLlmServer } = await import('@deepseek-ai/dsh-llm-mock-server')
  const mock = await startMockLlmServer({
    port: 0,
    apiKey: 'mock-key',
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: '已完成。',
    toolName: scenario.toolName,
    toolArguments: scenario.toolArguments,
  })

  const env = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    DSH_HOME: snapshot.homeDir,
    DSH_AGENTS_HOME: path.join(snapshot.homeDir, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    AGENT_SERVICE_SYSTEM_PROMPT: '你是海洋环境分析助手。',
    AGENT_STUDIO_TOOLS_DATA_DIR: path.join(snapshot.workspace, '.studio', 'data'),
    AGENT_STUDIO_OUTPUT_DIR: path.join(snapshot.workspace, '.studio', 'output'),
    AGENT_STUDIO_ALLOWED_STATIONS: 'ST-3101,ST-3102',
    DEEPSEEK_API_KEY: 'mock-key',
    DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
  }

  const { HarnessClient } = await import('@deepseek-ai/dsh-sdk-client')
  const client = new HarnessClient({
    dshBin: path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    profile: 'agent-service',
    dshHome: snapshot.homeDir,
    patches: snapshot.patches,
    processCwd: snapshot.workspace,
    env,
    initializeTimeoutMs: 60_000,
    requestTimeoutMs: 120_000,
  })

  const observed = { toolCalls: [], toolResults: [], assistant: '', idle: false, turnEnd: undefined }
  try {
    client.start()
    await client.initialize({ cwd: snapshot.workspace, provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 1024 })
    const sessionId = `probe-${Date.now().toString(36)}`
    const subscription = client.subscribeSessionTree(sessionId)
    await client.prompt(sessionId, [{ type: 'text', text: '请使用适合的技能回答。' }])

    const deadline = Date.now() + 90_000
    while (!observed.idle && Date.now() < deadline) {
      const notification = await subscription.next()
      if (notification.method === 'session.event') {
        const event = notification.params?.event
        if (event?.type === 'assistant/message') {
          const text = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
          if (text) observed.assistant = text
        } else if (event?.type === 'tool/call') {
          observed.toolCalls.push({ name: event.data?.name, arguments: event.data?.arguments })
        } else if (event?.type === 'tool/result') {
          const content = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ')
          observed.toolResults.push({ isError: event.data?.message?.isError === true, content })
        } else if (event?.type === 'turn/end') {
          observed.turnEnd = event.data?.reason?.kind
        }
      } else if (notification.method === 'session.status' && notification.params?.status === 'idle') {
        observed.idle = true
      }
    }
    subscription.close()
  } catch (error) {
    failures.push(`${scenario.name}: ${error?.message ?? error}`)
    log(`  ✗ 运行时异常：${error?.message ?? error}`)
  } finally {
    await client.close().catch(() => undefined)
    await mock.close()
    if (!keep) rmSync(snapshot.snapRoot, { recursive: true, force: true })
  }

  check(`${scenario.name}：收到工具调用`, observed.toolCalls.length > 0, JSON.stringify(observed.toolCalls))
  const call = observed.toolCalls[0]
  if (call !== undefined) {
    check(`${scenario.name}：工具名为 ${scenario.expectTool}`, call.name === scenario.expectTool, String(call.name))
  }
  const result = observed.toolResults[0]
  check(`${scenario.name}：工具结果${scenario.expectError ? '为错误' : '成功'}`,
    result !== undefined && result.isError === scenario.expectError,
    JSON.stringify(result))
  if (scenario.expectError && result !== undefined) {
    log(`    工具错误信息：${result.content.slice(0, 200)}`)
  }
  check(`${scenario.name}：本轮正常结束`, observed.idle && observed.turnEnd === 'completed', `idle=${observed.idle} turnEnd=${observed.turnEnd}`)
}

const SCENARIOS = [
  {
    name: 'skill',
    description: '被选中的 Skill 可被模型加载',
    skills: ['netcdf-analysis'],
    mcpServers: [],
    toolName: 'skill',
    toolArguments: JSON.stringify({ name: 'netcdf-analysis' }),
    expectTool: 'skill',
    expectError: false,
  },
  {
    name: 'skill-hidden',
    description: '未选中的 Skill 不可见（调用失败）',
    skills: ['netcdf-analysis'],
    mcpServers: [],
    toolName: 'skill',
    toolArguments: JSON.stringify({ name: 'gis-processing' }),
    expectTool: 'skill',
    expectError: true,
  },
  {
    name: 'mcp',
    description: '被选中的 MCP 服务器工具可被调用',
    skills: [],
    mcpServers: ['data-center'],
    toolName: 'mcp__data-center__search_dataset',
    toolArguments: JSON.stringify({ keyword: '流场' }),
    expectTool: 'mcp__data-center__search_dataset',
    expectError: false,
  },
]

const selected = only === undefined ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.name === only)
if (selected.length === 0) {
  process.stderr.write(`未知场景 ${only}，可用：${SCENARIOS.map((s) => s.name).join(', ')}\n`)
  process.exit(2)
}

log(`skills 源：${SKILLS_SOURCE}`)
for (const scenario of selected) {
  try {
    await runScenario(scenario)
  } catch (error) {
    failures.push(`${scenario.name}: ${error?.stack ?? error}`)
    log(`  ✗ ${error?.stack ?? error}`)
  }
}

log('')
log(failures.length === 0 ? `RUNTIME CHECK PASSED（${assertions} 项断言）` : `RUNTIME CHECK FAILED（${failures.length}/${assertions}）`)
for (const failure of failures) log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
