#!/usr/bin/env node
/**
 * 网关端到端验证：真实 HTTP + SSE + 真实 DSH 子进程（mock LLM，无网络无凭据）。
 *
 * 两种模式：
 *   --mode allow      (默认) 允许的工具链路：登录 → 建 Agent → 发布 → 会话 →
 *                     发消息（SSE）→ query_station 执行 → 审计落库 → 多轮 → 停止 → 越权抽查
 *   --mode approval   审批链路：ask 工具 → 前端收到 approval.required →
 *                     POST /api/approvals/:id/decision → 插件读到决定 → 执行/拒绝
 *
 * 用法：
 *   node scripts/e2e-gateway.mjs                 # 默认 allow 模式
 *   node scripts/e2e-gateway.mjs --mode approval
 *   node scripts/e2e-gateway.mjs --allow --approval   # 两种模式都跑（不同 mock 脚本）
 *
 * 前置：npm run build && npm run build:web
 * 退出码：0 通过；1 失败。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const port = Number(process.env.E2E_PORT ?? 8799)
const baseUrl = `http://127.0.0.1:${port}`
const runDir = path.join(root, '.tmp', 'e2e')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const modeFlagIndex = argv.indexOf('--mode')
const requestedModes = argv.includes('--allow') && argv.includes('--approval')
  ? ['allow', 'approval']
  : [modeFlagIndex >= 0 ? argv[modeFlagIndex + 1] ?? 'allow' : 'allow']

const failures = []
let assertions = 0
/** 每次运行用唯一 Agent id，避免复用旧 DATA_DIR 时撞唯一约束。 */
const runSuffix = Date.now().toString(36)

function log(message) {
  process.stdout.write(`${message}\n`)
}

function check(name, condition, detail) {
  assertions += 1
  if (condition) {
    log(`  ✓ ${name}`)
  } else {
    const text = detail === undefined ? name : `${name}: ${detail}`
    log(`  ✗ ${text}`)
    failures.push(text)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(pathname, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal })
    const text = await response.text()
    let body
    try {
      body = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      body = text
    }
    return { status: response.status, body, headers: response.headers }
  } finally {
    clearTimeout(timer)
  }
}

const authHeaders = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' })

async function startGateway(env, mode) {
  const entry = path.join(root, 'apps', 'gateway', 'dist', 'server.js')
  if (!existsSync(entry)) throw new Error(`网关未构建：${entry}（先运行 npm run build:gateway）`)

  const outLog = path.join(runDir, `gateway-${mode}.out.log`)
  const errLog = path.join(runDir, `gateway-${mode}.err.log`)
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], cwd: root })
  const outChunks = []
  const errChunks = []
  child.stdout.on('data', (chunk) => outChunks.push(chunk))
  child.stderr.on('data', (chunk) => errChunks.push(chunk))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const health = await request('/api/health', {}, 2_000)
      if (health.status === 200) {
        return { child, writeLogs: () => {
          writeFileSync(outLog, Buffer.concat(outChunks).toString('utf8'), 'utf8')
          writeFileSync(errLog, Buffer.concat(errChunks).toString('utf8'), 'utf8')
        } }
      }
    } catch {
      /* 启动中 */
    }
    await sleep(300)
  }
  child.kill()
  throw new Error(`网关 60s 内未就绪：${Buffer.concat(errChunks).toString('utf8').slice(-2000)}`)
}

/**
 * 消费 SSE 流直到终止事件。
 * @param response fetch 响应
 * @param onEvent 每收到一条事件时调用（可用于在流进行中做审批）
 */
async function readSse(response, onEvent, timeoutMs = 120_000) {
  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const eventLine = frame.split('\n').find((line) => line.startsWith('event:'))
      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
      if (eventLine && dataLine) {
        const type = eventLine.slice('event:'.length).trim()
        const data = JSON.parse(dataLine.slice('data:'.length).trim())
        const event = { type, data }
        events.push(event)
        if (onEvent) await onEvent(event, events)
        if (type === 'agent.completed' || type === 'agent.failed' || type === 'run.limit') {
          await reader.cancel().catch(() => {})
          return events
        }
      }
      index = buffer.indexOf('\n\n')
    }
  }
  await reader.cancel().catch(() => {})
  return events
}

async function login(username, password) {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

/** 创建并发布一个 Agent，返回 { agentId, version }。 */
async function createPublishedAgent(token, config) {
  const created = await request('/api/agents', {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(config),
  })
  check('创建 Agent 成功', created.status === 201 || created.status === 200, `status=${created.status} ${JSON.stringify(created.body)}`)
  const agentId = created.body?.id
  const published = await request(`/api/agents/${agentId}/publish`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  })
  check(
    '发布 Agent 通过运行时校验（--dump-config）',
    published.status === 200 && published.body?.verified === true,
    `status=${published.status} ${JSON.stringify(published.body?.warnings ?? published.body)}`,
  )
  return { agentId, version: published.body?.version }
}

async function createSession(token, agentId, title) {
  const session = await request(`/api/agents/${agentId}/sessions`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title }),
  })
  check('创建会话成功', session.status === 201 || session.status === 200, `status=${session.status} ${JSON.stringify(session.body)}`)
  return session.body?.id
}

/* ------------------------------------------------------------------ 场景：allow */

async function scenarioAllow(token) {
  const catalog = await request('/api/catalog/tools', { headers: authHeaders(token) })
  const toolNames = (catalog.body?.tools ?? []).map((tool) => tool.name)
  check('工具目录包含 4 个业务工具', toolNames.length >= 4, JSON.stringify(toolNames))
  check(
    '工具目录含 query_station / export_report',
    toolNames.includes('query_station') && toolNames.includes('export_report'),
    JSON.stringify(toolNames),
  )

  const { agentId, version } = await createPublishedAgent(token, {
    id: `e2e-water-agent-${runSuffix}`,
    name: 'E2E 水环境助手',
    description: '端到端验证用 Agent',
    model: { provider: 'deepseek-official', modelId: 'deepseek-flash' },
    prompt: { system: '你是水环境监测助手，只能使用已授权的业务工具。', welcome: '你好，请描述查询需求。' },
    capabilities: {
      tools: { query_station: 'allow', search_datasets: 'allow', export_report: 'ask' },
      mcpServers: [],
      skills: [],
      subagents: false,
    },
    limits: { maxTurns: 8, maxConcurrentRuns: 1, maxRequestsPerHour: 100 },
  })
  check('Agent 详情状态为 published', (await request(`/api/agents/${agentId}`, { headers: authHeaders(token) })).body?.status === 'published')

  const toolList = await request(`/api/agents/${agentId}/tools`, { headers: authHeaders(token) })
  const granted = (toolList.body?.tools ?? []).filter((tool) => tool.action !== 'deny').map((tool) => tool.name)
  check('Agent 工具页显示已授权工具', granted.includes('query_station'), JSON.stringify(granted))

  const sessionId = await createSession(token, agentId, 'E2E allow')
  const sessionInfo = await request(`/api/sessions/${sessionId}`, { headers: authHeaders(token) })
  check('会话绑定已发布版本', sessionInfo.body?.agentVersion === version, JSON.stringify(sessionInfo.body?.agentVersion))

  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content: '请查询 ST-3101 最近 7 天的监测数据。' }),
  })
  check(
    'SSE Content-Type 正确',
    (response.headers.get('content-type') ?? '').includes('text/event-stream'),
    response.headers.get('content-type') ?? '',
  )
  const events = await readSse(response)
  const types = events.map((event) => event.type)
  log(`  SSE：${types.join(' → ')}`)
  check('事件顺序包含 run.started → tool.started → tool.completed → agent.completed',
    types.join(',') === 'run.started,message.delta,tool.started,tool.completed,message.delta,agent.completed',
    types.join(','))
  check('tool.started 名称是 query_station', events.find((e) => e.type === 'tool.started')?.data?.tool === 'query_station')
  check('tool.completed 成功', events.find((e) => e.type === 'tool.completed')?.data?.success === true,
    JSON.stringify(events.find((e) => e.type === 'tool.completed')?.data))
  check('agent.completed 带最终文本', (events.find((e) => e.type === 'agent.completed')?.data?.text ?? '').length > 0)

  const messages = await request(`/api/sessions/${sessionId}/messages`, { headers: authHeaders(token) })
  const rows = messages.body?.items ?? []
  check('消息落库 user + assistant', rows.length >= 2 && rows[0]?.role === 'user', `count=${rows.length}`)

  const audit = await request('/api/audit/tool-calls?limit=50', { headers: authHeaders(token) })
  const allowed = (audit.body?.items ?? []).find((row) => row.tool === 'query_station')
  check('审计入表 query_station', allowed !== undefined, JSON.stringify((audit.body?.items ?? []).map((r) => r.tool)))
  check('审计 decision=allow', allowed?.decision === 'allow', JSON.stringify(allowed?.decision))
  check('审计 status=succeeded', allowed?.status === 'succeeded', JSON.stringify(allowed?.status))

  const second = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content: '再总结一下这项结论。' }),
  })
  const secondEvents = await readSse(second)
  check('第二轮正常完成', secondEvents.some((e) => e.type === 'agent.completed'), secondEvents.map((e) => e.type).join(','))
  const after = await request(`/api/sessions/${sessionId}/messages`, { headers: authHeaders(token) })
  check('多轮消息累计', (after.body?.total ?? 0) > (messages.body?.total ?? 0), `${messages.body?.total} → ${after.body?.total}`)

  const runtimeStatus = await request('/api/runtime/status', { headers: authHeaders(token) })
  check('运行时状态可查询', runtimeStatus.status === 200, JSON.stringify(runtimeStatus.body))

  const stopped = await request(`/api/sessions/${sessionId}/stop`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({}),
  })
  check('停止会话运行时成功', stopped.status === 200, `status=${stopped.status}`)

  const demo = await login('demo', 'demo123')
  check('普通用户登录成功', demo.status === 200)
  const demoToken = demo.body?.token
  check('普通用户不能读审计', (await request('/api/audit/tool-calls', { headers: authHeaders(demoToken) })).status === 403)
  check(
    '普通用户不能创建 Agent',
    (await request('/api/agents', { method: 'POST', headers: authHeaders(demoToken), body: JSON.stringify({ name: '越权' }) })).status === 403,
  )
}

/* --------------------------------------------------------------- 场景：approval */

async function scenarioApproval(token) {
  const { agentId } = await createPublishedAgent(token, {
    id: `e2e-report-agent-${runSuffix}`,
    name: 'E2E 报表助手',
    description: '验证 ask 审批链路',
    model: { provider: 'deepseek-official', modelId: 'deepseek-flash' },
    prompt: { system: '你是水环境报表助手，导出报表需要用户审批。' },
    capabilities: { tools: { export_report: 'ask' }, mcpServers: [], skills: [], subagents: false },
    limits: { maxTurns: 8, maxConcurrentRuns: 1, maxRequestsPerHour: 100 },
  })

  const sessionId = await createSession(token, agentId, 'E2E approval')

  // ---- 第一次：批准
  let approvalId
  let decisionPosted = false
  const approveResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content: '请导出 ST-3101 的 PDF 报表。' }),
  })
  const approveEvents = await readSse(approveResponse, async (event) => {
    if (event.type === 'approval.required' && !decisionPosted) {
      decisionPosted = true
      approvalId = event.data.approvalId
      log(`  approval.required: ${event.data.tool} / ${event.data.approvalId}`)
      const decided = await request(`/api/approvals/${event.data.approvalId}/decision`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ decision: 'allowed-once', reason: 'e2e 批准' }),
      })
      check('审批决定被接受', decided.status === 200, `status=${decided.status} ${JSON.stringify(decided.body)}`)
    }
  })
  const approveTypes = approveEvents.map((event) => event.type)
  log(`  SSE（批准）：${approveTypes.join(' → ')}`)
  check('收到 approval.required', approveTypes.includes('approval.required'), approveTypes.join(','))
  check('收到 approval.decided', approveTypes.includes('approval.decided'), approveTypes.join(','))
  check(
    '批准后工具执行成功',
    approveEvents.find((e) => e.type === 'tool.completed')?.data?.success === true,
    JSON.stringify(approveEvents.find((e) => e.type === 'tool.completed')?.data),
  )
  const auditAfterApprove = await request('/api/audit/tool-calls?limit=50', { headers: authHeaders(token) })
  const approvedRow = (auditAfterApprove.body?.items ?? []).find((row) => row.tool === 'export_report')
  check('审计记录 decision=approved', approvedRow?.decision === 'approved', JSON.stringify(approvedRow?.decision))
  check('审计记录 status=succeeded', approvedRow?.status === 'succeeded', JSON.stringify(approvedRow?.status))

  const approvals = await request(`/api/sessions/${sessionId}/approvals`, { headers: authHeaders(token) })
  const approvedRecord = (approvals.body?.items ?? []).find((row) => row.approvalId === approvalId)
  check('审批记录状态为 allowed', approvedRecord?.status === 'allowed', JSON.stringify(approvedRecord?.status))

  // ---- 第二次：拒绝
  let rejectApprovalId
  let rejectPosted = false
  const rejectResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content: '再导出一份 PDF 报表。' }),
  })
  const rejectEvents = await readSse(rejectResponse, async (event) => {
    if (event.type === 'approval.required' && !rejectPosted) {
      rejectPosted = true
      rejectApprovalId = event.data.approvalId
      const decided = await request(`/api/approvals/${event.data.approvalId}/decision`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ decision: 'rejected', reason: 'e2e 拒绝' }),
      })
      check('拒绝决定被接受', decided.status === 200, `status=${decided.status}`)
    }
  })
  const rejectTypes = rejectEvents.map((event) => event.type)
  log(`  SSE（拒绝）：${rejectTypes.join(' → ')}`)
  const rejectedResult = rejectEvents.find((e) => e.type === 'tool.completed')
  check('拒绝后工具执行失败', rejectedResult?.data?.success === false, JSON.stringify(rejectedResult?.data))
  check('拒绝后仍正常结束本轮', rejectTypes.includes('agent.completed'), rejectTypes.join(','))

  const auditFinal = await request('/api/audit/tool-calls?limit=100', { headers: authHeaders(token) })
  const rejectedRow = (auditFinal.body?.items ?? []).find(
    (row) => row.tool === 'export_report' && row.decision === 'rejected',
  )
  check('审计记录 decision=rejected', rejectedRow !== undefined, JSON.stringify((auditFinal.body?.items ?? []).map((r) => r.decision)))

  const approvals2 = await request(`/api/sessions/${sessionId}/approvals`, { headers: authHeaders(token) })
  const rejectedRecord = (approvals2.body?.items ?? []).find((row) => row.approvalId === rejectApprovalId)
  check('审批记录状态为 rejected', rejectedRecord?.status === 'rejected', JSON.stringify(rejectedRecord?.status))

  // ---- 越权审批：普通用户不能批别人的会话
  const demo = await login('demo', 'demo123')
  const forbidden = await request(`/api/approvals/${approvalId}/decision`, {
    method: 'POST',
    headers: authHeaders(demo.body?.token),
    body: JSON.stringify({ decision: 'allowed-once' }),
  })
  check('普通用户不能审批他人会话', forbidden.status === 403 || forbidden.status === 404, `status=${forbidden.status}`)
}

/* ---------------------------------------------------------------------- 主流程 */

async function runMode(mode) {
  log('')
  log(`=== e2e 模式：${mode} ===`)
  const dataDir = path.join(runDir, `${mode}-data`)
  const runtimeDir = path.join(runDir, `${mode}-runtime`)
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  const { startMockLlmServer } = await import('@deepseek-ai/dsh-llm-mock-server')
  const approvalMode = mode === 'approval'
  const mock = await startMockLlmServer({
    port: 0,
    apiKey: 'mock-key',
    sequence: approvalMode
      ? ['tool_call_success', 'success', 'tool_call_success', 'success']
      : ['tool_call_success', 'success'],
    repeatLast: true,
    successText: approvalMode
      ? '报表任务已生成：ST-3101 最近 7 天水质报表（PDF）。'
      : '查询完成：ST-3101 最近 7 天溶解氧均值 7.1 mg/L，水质类别为 II 类。',
    toolName: approvalMode ? 'export_report' : 'query_station',
    toolArguments: approvalMode ? '{"stationId":"ST-3101","format":"pdf"}' : '{"stationId":"ST-3101","days":7}',
  })
  log(`mock LLM: ${mock.baseURL}`)

  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    RUNTIME_DIR: runtimeDir,
    LOG_LEVEL: 'info',
    MOCK_LLM: '1',
    DEEPSEEK_API_KEY: 'mock-key',
    DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
    AGENT_STUDIO_DSH_PROFILE: 'studio',
    WEB_DIST: path.join(root, 'apps', 'web', 'dist'),
  }
  delete env.DSH_PROFILE

  const gateway = await startGateway(env, mode)
  let exitCode = 0
  try {
    const health = await request('/api/health')
    check('GET /api/health 返回 200', health.status === 200, JSON.stringify(health.body))
    check('健康检查报告 DSH 版本', typeof health.body?.dshVersion === 'string', JSON.stringify(health.body))

    if (mode === 'allow') {
      const webIndex = await fetch(`${baseUrl}/`)
      check('网关托管前端静态资源', webIndex.status === 200, `status=${webIndex.status}`)
    }

    check('错误密码被拒绝', (await login('admin', 'wrong-password')).status === 401)
    const admin = await login('admin', 'admin123')
    check('管理员登录成功', admin.status === 200 && typeof admin.body?.token === 'string', `status=${admin.status}`)
    const token = admin.body?.token
    if (token === undefined) throw new Error('没有拿到 token')
    check('GET /api/auth/me 返回管理员身份', (await request('/api/auth/me', { headers: authHeaders(token) })).body?.role === 'admin')

    if (mode === 'approval') await scenarioApproval(token)
    else await scenarioAllow(token)
  } catch (error) {
    failures.push(`异常（${mode}）：${error?.stack ?? error}`)
    process.stderr.write(`[e2e] ${error?.stack ?? error}\n`)
    exitCode = 1
  } finally {
    gateway.child.kill()
    await sleep(600)
    gateway.writeLogs()
    await mock.close()
  }
  return exitCode
}

for (const mode of requestedModes) {
  if (mode !== 'allow' && mode !== 'approval') {
    process.stderr.write(`未知模式：${mode}（可选 allow / approval）\n`)
    process.exit(2)
  }
}

let failed = false
for (const mode of requestedModes) {
  const code = await runMode(mode)
  failed = failed || code !== 0
}

log('')
if (failures.length === 0) {
  log(`E2E PASSED（${assertions} 项断言，模式：${requestedModes.join(', ')}）`)
  if (!keep) rmSync(runDir, { recursive: true, force: true })
  process.exit(0)
}
log(`E2E FAILED（${failures.length}/${assertions} 项失败）`)
for (const failure of failures) log(`  - ${failure}`)
process.exit(1)
