#!/usr/bin/env node
/**
 * 端到端验证：用官方 SDK 客户端驱动**真实**的 DSH 运行时子进程，验证受限 Agent
 * 的完整链路（profile 组合 → 握手 → 工具注册 → 策略拦截 → 审批通道 → 审计）。
 *
 * 每个场景都从零启动一个运行时（独立 DSH_HOME / 工作目录 / 策略快照），
 * 用进程内 mock LLM 扮演模型，因此**不需要 API Key、不联网**，可以直接进 CI。
 *
 * 场景：
 *   text    纯文本回复（基线：链路通）
 *   allow   调用被 allow 的业务工具 → 必须成功，审计记录 allow/succeeded
 *   deny    调用未授权的业务工具 → 必须失败，审计记录 deny/denied
 *   ask     调用 ask 工具 → 网关侧写 allowed-once → 必须成功，审计 approved
 *   reject  调用 ask 工具 → 网关侧写 rejected → 必须失败，审计 rejected
 *
 * 用法：
 *   node scripts/smoke-run.mjs --scenario allow
 *   node scripts/smoke-run.mjs --all            # 依次跑全部场景
 *   node scripts/smoke-run.mjs --live --scenario text --prompt "你好"
 *   node scripts/smoke-run.mjs --profile sdk-minimal --scenario text
 *
 * 退出码：0 全部通过；1 有场景失败。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const SCENARIOS = ['text', 'allow', 'deny', 'ask', 'reject']

/** 场景定义：模型行为、策略授权、期望结果。 */
const SCENARIO_DEFS = {
  text: {
    description: '纯文本回复',
    tools: { search_datasets: 'allow', query_station: 'allow', map_fly_to: 'allow' },
    toolName: undefined,
    toolArguments: undefined,
    expectedToolError: false,
    expectedToolCalls: 0,
    approval: undefined,
  },
  allow: {
    description: '允许的工具可以执行',
    tools: { search_datasets: 'allow', query_station: 'allow', map_fly_to: 'allow' },
    toolName: 'query_station',
    toolArguments: '{"stationId":"ST-3101","days":7}',
    expectedToolError: false,
    expectedToolCalls: 1,
    approval: undefined,
  },
  deny: {
    description: '未授权工具被拒绝',
    tools: { search_datasets: 'allow' },
    toolName: 'query_station',
    toolArguments: '{"stationId":"ST-3101","days":7}',
    expectedToolError: true,
    expectedToolCalls: 1,
    approval: undefined,
  },
  ask: {
    description: 'ask 工具经人工审批后执行',
    tools: { search_datasets: 'allow', export_report: 'ask' },
    toolName: 'export_report',
    toolArguments: '{"stationId":"ST-3101","format":"pdf"}',
    expectedToolError: false,
    expectedToolCalls: 1,
    approval: 'allowed-once',
  },
  reject: {
    description: 'ask 工具被人工拒绝',
    tools: { search_datasets: 'allow', export_report: 'ask' },
    toolName: 'export_report',
    toolArguments: '{"stationId":"ST-3101","format":"pdf"}',
    expectedToolError: true,
    expectedToolCalls: 1,
    approval: 'rejected',
  },
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      args[key] = next
      i += 1
    } else {
      args[key] = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const profile = typeof args.profile === 'string' ? args.profile : 'studio'
const live = args.live === true
const keep = args.keep === true
const prompt = typeof args.prompt === 'string' ? args.prompt : '请查询 ST-3101 最近 7 天的监测数据。'
const model = typeof args.model === 'string' ? args.model : 'deepseek-flash'
const provider = typeof args.provider === 'string' ? args.provider : 'deepseek-official'
const scenarios = args.all === true
  ? SCENARIOS
  : [typeof args.scenario === 'string' ? args.scenario : 'text']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message) {
  process.stdout.write(`${message}\n`)
}

/** 准备一个隔离的运行目录：DSH_HOME、工作目录、策略快照、业务数据、控制通道。 */
function prepareRuntime(runId, scenario) {
  const def = SCENARIO_DEFS[scenario]
  const runRoot = path.join(root, '.tmp', 'smoke', `${runId}-${scenario}`)
  const homeDir = path.join(runRoot, 'home')
  const workspaceDir = path.join(runRoot, 'workspace')
  mkdirSync(homeDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })

  if (profile === 'studio') {
    const templateDir = path.join(root, 'runtime', 'templates', 'studio')
    const profileDir = path.join(homeDir, 'profiles', 'studio')
    mkdirSync(profileDir, { recursive: true })

    const substitutions = {
      '{{POLICY_PLUGIN}}': path.join(root, 'plugins', 'agent-policy', 'dist', 'index.js'),
      '{{TOOLS_PLUGIN}}': path.join(root, 'plugins', 'agent-tools', 'dist', 'index.js'),
      '{{AUDIT_PLUGIN}}': path.join(root, 'plugins', 'agent-audit', 'dist', 'index.js'),
      '{{WORKSPACE}}': workspaceDir,
    }

    for (const file of ['package.json', 'cordis.patch.yml']) {
      let text = readFileSync(path.join(templateDir, file), 'utf8')
      for (const [token, value] of Object.entries(substitutions)) {
        text = text.split(token).join(value.replaceAll('\\', '/'))
      }
      writeFileSync(path.join(profileDir, file), text, 'utf8')
    }

    for (const plugin of ['agent-policy', 'agent-tools', 'agent-audit']) {
      const entry = path.join(root, 'plugins', plugin, 'dist', 'index.js')
      if (!existsSync(entry)) {
        throw new Error(
          `受限插件未构建：${entry}。请先运行 npm run build:plugins。`,
        )
      }
    }
  }

  // 业务工具的数据目录：<workspace>/.studio/data
  const dataDir = path.join(workspaceDir, '.studio', 'data')
  mkdirSync(dataDir, { recursive: true })
  for (const file of ['datasets.json', 'stations.json']) {
    const source = path.join(root, 'runtime', 'tools', file)
    if (existsSync(source)) cpSync(source, path.join(dataDir, file))
  }

  const controlDir = path.join(workspaceDir, '.studio', 'control')
  const auditDir = path.join(workspaceDir, '.studio', 'audit')
  mkdirSync(path.join(controlDir, 'approvals'), { recursive: true })
  mkdirSync(auditDir, { recursive: true })

  const policyPath = path.join(runRoot, 'policy.json')
  writeFileSync(
    policyPath,
    `${JSON.stringify(
      {
        snapshotVersion: 1,
        agentId: 'smoke-agent',
        agentVersion: 1,
        runtimeId: runId,
        sessionId: 'smoke-session',
        userId: 'smoke-user',
        issuedAt: Date.now(),
        tools: def.tools,
        defaultAction: 'deny',
        approvalTimeoutMs: 20_000,
        controlDir: controlDir.replaceAll('\\', '/'),
        auditPath: path.join(auditDir, 'tool-calls.jsonl').replaceAll('\\', '/'),
        maxToolCalls: 0,
        maxTurns: 20,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return {
    def,
    runRoot,
    homeDir,
    workspaceDir,
    controlDir,
    auditDir,
    auditFile: path.join(auditDir, 'tool-calls.jsonl'),
    policyPath,
  }
}

/** 读取并解析审计 JSONL。 */
function readAudit(auditFile) {
  if (!existsSync(auditFile)) return []
  return readFileSync(auditFile, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { malformed: line }
      }
    })
}

/**
 * 扮演"网关"：轮询审批请求文件，按剧本写入决定。
 * @returns 清理函数
 */
function startApprover(controlDir, decision, onDecision) {
  const approvalsDir = path.join(controlDir, 'approvals')
  const handled = new Set()
  const timer = setInterval(() => {
    let entries
    try {
      entries = readdirSync(approvalsDir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith('.request.json')) continue
      const approvalId = entry.slice(0, -'.request.json'.length)
      if (handled.has(approvalId)) continue
      handled.add(approvalId)
      const decisionBody = JSON.stringify({
        approvalId,
        decision,
        decidedBy: 'smoke-approver',
        decidedAt: Date.now(),
        reason: `smoke scenario ${decision}`,
      })
      const target = path.join(approvalsDir, `${approvalId}.decision.json`)
      const temp = `${target}.tmp`
      writeFileSync(temp, decisionBody, 'utf8')
      try {
        rmSync(target, { force: true })
      } catch {
        /* ignore */
      }
      cpSync(temp, target)
      rmSync(temp, { force: true })
      onDecision(approvalId, decision)
    }
  }, 50)
  return () => clearInterval(timer)
}

async function runScenario(scenario) {
  const runId = `smoke-${Date.now().toString(36)}`
  const runtime = prepareRuntime(runId, scenario)
  const { def } = runtime
  log('')
  log(`=== scenario: ${scenario} (${def.description}) profile=${profile} live=${live} ===`)
  log(`run dir: ${runtime.runRoot}`)

  const dshBin = path.join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(dshBin)) throw new Error(`找不到 DSH CLI: ${dshBin}`)

  const env = {
    PATH: process.env.PATH ?? '',
    SYSTEMROOT: process.env.SYSTEMROOT ?? '',
    TEMP: process.env.TEMP ?? '',
    TMP: process.env.TMP ?? '',
    DSH_HOME: runtime.homeDir,
    DSH_TELEMETRY_DISABLED: '1',
    AGENT_STUDIO_POLICY: runtime.policyPath,
    AGENT_STUDIO_CONTROL_DIR: runtime.controlDir,
    AGENT_STUDIO_AUDIT_PATH: runtime.auditFile,
    AGENT_STUDIO_SESSION_ID: 'smoke-session',
    AGENT_STUDIO_USER_ID: 'smoke-user',
    AGENT_STUDIO_AGENT_ID: 'smoke-agent',
    AGENT_STUDIO_AGENT_VERSION: '1',
    AGENT_STUDIO_APPROVAL_TIMEOUT_MS: '20000',
    AGENT_STUDIO_ALLOWED_STATIONS: 'ST-3101,ST-3102',
    DSH_SYSTEM_PROMPT: '你是水环境监测助手，只能使用已授权的业务工具。',
  }

  let mock
  if (!live) {
    const { startMockLlmServer } = await import('@deepseek-ai/dsh-llm-mock-server')
    mock = await startMockLlmServer({
      port: 0,
      apiKey: 'mock-key',
      sequence: def.toolName ? ['tool_call_success', 'success'] : ['success'],
      repeatLast: true,
      successText: '查询完成：ST-3101 最近 7 天溶解氧均值 7.1 mg/L。',
      toolName: def.toolName,
      toolArguments: def.toolArguments,
    })
    env.DEEPSEEK_BASE_URL = `${mock.baseURL}/v1`
    env.DEEPSEEK_API_KEY = 'mock-key'
    log(`mock LLM: ${mock.baseURL}`)
  } else {
    if (!process.env.DEEPSEEK_API_KEY) throw new Error('--live 需要 DEEPSEEK_API_KEY')
    env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
    if (process.env.DEEPSEEK_BASE_URL) env.DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL
  }

  const { HarnessClient } = await import('@deepseek-ai/dsh-sdk-client')
  const client = new HarnessClient({
    dshBin,
    profile,
    dshHome: runtime.homeDir,
    processCwd: runtime.workspaceDir,
    env,
    initializeTimeoutMs: 60_000,
    requestTimeoutMs: 120_000,
  })

  const failures = []
  const observed = {
    assistantText: '',
    toolCalls: [],
    toolResults: [],
    approvalsSeen: [],
    turnEnd: undefined,
    idle: false,
  }

  const stopApprover = def.approval
    ? startApprover(runtime.controlDir, def.approval, (approvalId) => {
        observed.approvalsSeen.push(approvalId)
        log(`  → approver wrote ${def.approval} for ${approvalId}`)
      })
    : undefined

  try {
    client.start()
    const init = await client.initialize({
      cwd: runtime.workspaceDir,
      provider,
      model,
      maxTokens: 1024,
    })
    log(`initialize ok: ${init.serverInfo.name}@${init.serverInfo.version}`)

    const sessionId = `smoke-${runId}`
    const subscription = client.subscribeSessionTree(sessionId)
    await client.prompt(sessionId, [{ type: 'text', text: prompt }])
    log('prompt queued')

    const deadline = Date.now() + 90_000
    while (!observed.idle && Date.now() < deadline) {
      const notification = await subscription.next()
      if (notification.method === 'session.event') {
        const event = notification.params?.event
        if (!event) continue
        switch (event.type) {
          case 'assistant/message': {
            const text = (event.data?.message?.content ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join('')
            if (text) observed.assistantText = text
            log(`  assistant/message: ${JSON.stringify(text.slice(0, 80))}`)
            break
          }
          case 'tool/call': {
            observed.toolCalls.push({ name: event.data?.name, arguments: event.data?.arguments })
            log(`  tool/call ${event.data?.name} ${String(event.data?.arguments ?? '').slice(0, 80)}`)
            break
          }
          case 'tool/result': {
            const isError = event.data?.message?.isError === true
            const content = (event.data?.message?.content ?? [])
              .filter((block) => block.type === 'text')
              .map((block) => block.text)
              .join(' ')
            observed.toolResults.push({ isError, content })
            log(`  tool/result ${isError ? 'ERROR' : 'ok'}: ${content.slice(0, 160)}`)
            break
          }
          case 'turn/end': {
            observed.turnEnd = event.data?.reason?.kind
            log(`  turn/end ${observed.turnEnd}`)
            break
          }
          case 'approval/asked':
          case 'approval/decided':
            log(`  ${event.type} ${JSON.stringify(event.data)}`)
            break
          default:
            break
        }
      } else if (notification.method === 'session.status') {
        const status = notification.params?.status
        if (notification.params?.sessionId === sessionId && status === 'idle') {
          observed.idle = true
          log('  session.status idle')
        }
      }
    }
    subscription.close()
  } catch (error) {
    failures.push(`${error?.constructor?.name ?? 'Error'}: ${error?.message ?? String(error)}`)
  } finally {
    stopApprover?.()
    try {
      await client.close()
    } catch (error) {
      log(`close failed: ${error?.message ?? error}`)
    }
    if (mock) await mock.close()
  }

  // ---------------------------------------------------------------- 断言
  const audit = readAudit(runtime.auditFile)
  if (!observed.idle) failures.push('未在 90s 内进入 idle')
  if (!observed.assistantText) failures.push('没有收到 assistant 文本')
  if (observed.toolCalls.length !== def.expectedToolCalls) {
    failures.push(`工具调用次数 ${observed.toolCalls.length} != 期望 ${def.expectedToolCalls}`)
  }
  if (def.toolName && observed.toolCalls[0]?.name !== def.toolName) {
    failures.push(`首个工具调用是 ${observed.toolCalls[0]?.name}，期望 ${def.toolName}`)
  }
  const lastResult = observed.toolResults.at(-1)
  if (def.toolName) {
    if (!lastResult) failures.push('没有收到 tool/result')
    else if (lastResult.isError !== def.expectedToolError) {
      failures.push(`tool/result isError=${lastResult.isError}，期望 ${def.expectedToolError}`)
    }
  }
  if (def.approval) {
    if (observed.approvalsSeen.length === 0) failures.push('审批通道没有产生请求文件')
    const approvalRecords = audit.filter((row) => row.approvalId)
    if (approvalRecords.length === 0) failures.push('审计里没有审批相关记录')
    const expectedDecision = def.approval === 'allowed-once' ? 'approved' : 'rejected'
    if (!audit.some((row) => row.decision === expectedDecision)) {
      failures.push(`审计里缺少 decision=${expectedDecision} 的记录`)
    }
  }
  if (scenario === 'deny') {
    if (!audit.some((row) => row.decision === 'deny')) failures.push('审计里缺少 decision=deny 记录')
  }
  if (scenario === 'allow' && !audit.some((row) => row.status === 'succeeded')) {
    failures.push('审计里缺少 status=succeeded 记录')
  }
  if (profile === 'studio' && observed.turnEnd === 'error') {
    failures.push('turn 以 error 结束')
  }

  log(`审计记录 ${audit.length} 条：`)
  for (const row of audit) {
    log(
      `  - ${row.tool ?? '?'} decision=${row.decision ?? '?'} status=${row.status ?? '?'}` +
        `${row.approvalId ? ` approval=${row.approvalId}` : ''}` +
        `${row.error ? ` error=${String(row.error).slice(0, 80)}` : ''}`,
    )
  }

  writeFileSync(
    path.join(runtime.runRoot, 'result.json'),
    `${JSON.stringify({ scenario, observed, audit, failures }, null, 2)}\n`,
    'utf8',
  )

  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`)
  } else {
    log(`  ✓ ${scenario} 通过`)
  }

  if (!keep && failures.length === 0) rmSync(runtime.runRoot, { recursive: true, force: true })
  else log(`  保留运行目录：${runtime.runRoot}`)

  return failures.length === 0
}

let allPassed = true
for (const scenario of scenarios) {
  if (!SCENARIO_DEFS[scenario]) {
    process.stderr.write(`未知场景: ${scenario}（可选：${SCENARIOS.join(', ')}）\n`)
    process.exit(2)
  }
  try {
    const passed = await runScenario(scenario)
    allPassed = allPassed && passed
  } catch (error) {
    allPassed = false
    process.stderr.write(`场景 ${scenario} 异常: ${error?.stack ?? error}\n`)
  }
}

log('')
log(allPassed ? 'ALL SCENARIOS PASSED' : 'SOME SCENARIOS FAILED')
process.exit(allPassed ? 0 : 1)
