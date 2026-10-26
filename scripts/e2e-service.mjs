#!/usr/bin/env node
/**
 * DSH Agent Service 端到端验证：真实 HTTP/SSE + 真实 DSH 运行时 + mock 模型。
 *
 * 两个阶段（mock 模型一次只能脚本化一个工具名，所以分两轮起服务）：
 *
 *   阶段 A —— Skills 与配置
 *     /api/skills、/api/mcp-servers、项目配置读写、创建对话（继承项目配置）、
 *     修改对话配置（未开始）→ 已开始则 409、发消息（model 调用 skill 工具）、
 *     历史消息、运行时复用（同配置两个对话共用一个运行时）
 *
 *   阶段 B —— MCP 与配置隔离
 *     选中 data-center → 模型调用 mcp__data-center__search_dataset 成功；
 *     不选 MCP 的同名调用失败（工具不存在）；不同配置 → 两个运行时
 *
 * 用法：
 *   node scripts/e2e-service.mjs              # 两个阶段
 *   node scripts/e2e-service.mjs --phase a    # 只跑阶段 A
 *   node scripts/e2e-service.mjs --keep       # 保留数据目录
 *
 * 前置：npm run build（网关 + 插件 + 前端）
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const phaseIndex = argv.indexOf('--phase')
const phases = phaseIndex >= 0 ? [String(argv[phaseIndex + 1]).toLowerCase()] : ['a', 'b']

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
    const text = detail === undefined ? name : `${name}: ${detail}`
    log(`  ✗ ${text}`)
    failures.push(text)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 带超时的 JSON 请求。 */
async function request(baseUrl, pathname, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // 只在有 body 时声明 Content-Type：DELETE/POST 空 body 带 application/json 会被
    // Fastify 判成 FST_ERR_CTP_EMPTY_JSON_BODY（400），这不是被测服务的问题。
    const response = await fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      signal: controller.signal,
    })
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

/** 消费 SSE，返回事件数组；onEvent 可用于中途操作。 */
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
        if (type === 'message.failed') {
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

/** 启动 mock 模型 + 服务，返回句柄。 */
async function boot(phase, options) {
  const dir = path.join(root, '.tmp', 'e2e-service', phase)
  if (!keep) rmSync(dir, { recursive: true, force: true })
  const dataDir = path.join(dir, 'data')
  const runtimeDir = path.join(dir, 'runtime')
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })

  const { startMockLlmServer } = await import('@deepseek-ai/dsh-llm-mock-server')
  const mock = await startMockLlmServer({
    port: 0,
    apiKey: 'mock-key',
    // 每一轮都用「先要工具调用、再给结论」的两条脚本；repeatLast 兜住多余请求
    sequence: options.sequence ?? ['tool_call_success', 'success'],
    repeatLast: true,
    successText: options.successText,
    toolName: options.toolName,
    toolArguments: options.toolArguments,
  })

  const port = options.port
  const baseUrl = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    RUNTIME_DIR: runtimeDir,
    SKILLS_DIRS: path.join(root, 'runtime', 'skills'),
    MCP_CONFIG: path.join(root, 'config', 'mcp-servers.json'),
    AGENT_SERVICE_TOOLS_DATA_DIR: path.join(root, 'runtime', 'tools'),
    AGENT_SERVICE_DSH_PROFILE: 'agent-service',
    MOCK_LLM: '1',
    DEEPSEEK_API_KEY: 'mock-key',
    DEEPSEEK_BASE_URL: `${mock.baseURL}/v1`,
    WEB_DIST: path.join(root, 'apps', 'web', 'dist'),
    RUNTIME_IDLE_MS: '600000',
    LOG_LEVEL: 'info',
  }
  delete env.DSH_PROFILE
  delete env.DSH_HOME

  const entry = path.join(root, 'apps', 'gateway', 'dist', 'server.js')
  if (!existsSync(entry)) throw new Error(`服务未构建：${entry}（先 npm run build:gateway）`)
  const child = spawn(process.execPath, [entry], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  const err = []
  child.stdout.on('data', (chunk) => out.push(chunk))
  child.stderr.on('data', (chunk) => err.push(chunk))

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const health = await request(baseUrl, '/api/health', {}, 2_000)
      if (health.status === 200) {
        return {
          baseUrl,
          mock,
          child,
          dir,
          health: health.body,
          stop: async () => {
            child.kill()
            await sleep(500)
            await mock.close()
            writeFileSync(path.join(dir, 'service.out.log'), Buffer.concat(out).toString('utf8'), 'utf8')
            writeFileSync(path.join(dir, 'service.err.log'), Buffer.concat(err).toString('utf8'), 'utf8')
            if (!keep) rmSync(dir, { recursive: true, force: true })
          },
          stderr: () => Buffer.concat(err).toString('utf8'),
        }
      }
    } catch {
      /* 启动中 */
    }
    await sleep(300)
  }
  child.kill()
  throw new Error(`服务 60s 未就绪：${Buffer.concat(err).toString('utf8').slice(-1500)}`)
}

/** 发一条消息并返回 SSE 事件（断言用）。 */
async function sendMessage(baseUrl, conversationId, content) {
  const response = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`发送消息失败 HTTP ${response.status}: ${text}`)
  }
  return await readSse(response)
}

/* ------------------------------------------------------------------ 阶段 A */

async function phaseA() {
  log('')
  log('=== 阶段 A：Skills、项目/对话配置、历史消息、运行时复用 ===')
  const s = await boot('a', {
    port: 8795,
    toolName: 'skill',
    toolArguments: JSON.stringify({ name: 'netcdf-analysis' }),
    successText: '已按 netcdf-analysis 技能的口径给出结论：长江口 2026-10-20 平均流速 0.82 m/s。',
  })
  try {
    check('健康检查 dshVersion', typeof s.health?.dshVersion === 'string', JSON.stringify(s.health))

    // ---- 能力清单
    const skills = await request(s.baseUrl, '/api/skills')
    check('GET /api/skills 200', skills.status === 200)
    const skillNames = (skills.body?.skills ?? []).map((skill) => skill.name)
    check('技能清单含 netcdf-analysis / gis-processing / model-analysis',
      ['netcdf-analysis', 'gis-processing', 'model-analysis'].every((name) => skillNames.includes(name)),
      JSON.stringify(skillNames))
    const skillEntry = (skills.body?.skills ?? []).find((skill) => skill.name === 'netcdf-analysis')
    check('技能带 description', typeof skillEntry?.description === 'string' && skillEntry.description.length > 0)
    check('技能 roots 可见', Array.isArray(skills.body?.roots) && skills.body.roots.length > 0, JSON.stringify(skills.body?.roots))

    // ---- 模型清单必须来自 DSH（而不是服务里写死的常量）
    const models = await request(s.baseUrl, '/api/models')
    check('GET /api/models 200', models.status === 200, `status=${models.status}`)
    const providers = models.body?.providers ?? []
    check('模型清单来自运行时（source=live）', models.body?.source === 'live', String(models.body?.source))
    check('清单含 deepseek-official', providers.some((item) => item.id === 'deepseek-official'),
      JSON.stringify(providers.map((item) => item.id)))
    const officialModels = (providers.find((item) => item.id === 'deepseek-official')?.models ?? []).map((item) => item.id)
    check('清单含 deepseek-flash', officialModels.includes('deepseek-flash'), JSON.stringify(officialModels))
    check('默认路由由清单给出',
      (models.body?.default?.provider ?? '') !== '' && (models.body?.default?.model ?? '') !== '',
      JSON.stringify(models.body?.default))

    const mcp = await request(s.baseUrl, '/api/mcp-servers')
    check('GET /api/mcp-servers 200', mcp.status === 200)
    const mcpIds = (mcp.body?.servers ?? []).map((server) => server.id)
    check('MCP 清单含 data-center', mcpIds.includes('data-center'), JSON.stringify(mcpIds))
    const disabledMcp = (mcp.body?.servers ?? []).find((server) => server.id === 'gis-service')
    check('禁用的服务器也列出但 enabled=false', disabledMcp === undefined || disabledMcp.enabled === false)
    const dataCenter = (mcp.body?.servers ?? []).find((server) => server.id === 'data-center')
    check('MCP 清单标注来源 config', dataCenter?.source === 'config', JSON.stringify(dataCenter))

    // ---- 项目配置
    const projectId = 'ocean-project'
    const before = await request(s.baseUrl, `/api/projects/${projectId}/agent-config`)
    check('未保存时返回默认配置且 saved=false', before.status === 200 && before.body?.saved === false, JSON.stringify(before.body))
    const saved = await request(s.baseUrl, `/api/projects/${projectId}/agent-config`, {
      method: 'PUT',
      body: JSON.stringify({ skills: ['netcdf-analysis'], mcpServers: [], model: 'deepseek-flash' }),
    })
    check('PUT 项目配置成功', saved.status === 200 && saved.body?.saved === true, JSON.stringify(saved.body))
    const after = await request(s.baseUrl, `/api/projects/${projectId}/agent-config`)
    check('GET 回读项目配置', (after.body?.skills ?? []).includes('netcdf-analysis'), JSON.stringify(after.body?.skills))

    // ---- 未知能力被拒绝
    const badSkill = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, skills: ['no-such-skill'] }),
    })
    check('未知技能返回 400 SKILL_UNKNOWN', badSkill.status === 400 && badSkill.body?.error?.code === 'SKILL_UNKNOWN', JSON.stringify(badSkill.body))
    const badMcp = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, mcpServers: ['no-such-server'] }),
    })
    check('未知 MCP 返回 400 MCP_UNKNOWN', badMcp.status === 400 && badMcp.body?.error?.code === 'MCP_UNKNOWN', JSON.stringify(badMcp.body))
    const badModel = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, model: 'no-such-model' }),
    })
    check('未知模型返回 400 MODEL_UNKNOWN',
      badModel.status === 400 && badModel.body?.error?.code === 'MODEL_UNKNOWN',
      `status=${badModel.status} ${JSON.stringify(badModel.body)}`)

    // ---- 创建对话（继承项目配置）
    const created = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, title: 'E2E 技能对话' }),
    })
    check('创建对话 201', created.status === 201, `status=${created.status} ${JSON.stringify(created.body)}`)
    const conversationId = created.body?.conversationId
    const sessionId = created.body?.sessionId
    check('返回 conversationId + sessionId', typeof conversationId === 'string' && typeof sessionId === 'string')
    const snapshot = created.body?.config
    check('快照继承项目 skills', (snapshot?.skills ?? []).includes('netcdf-analysis'), JSON.stringify(snapshot?.skills))
    check('快照的 provider/model 来自 DSH 清单',
      snapshot?.provider === models.body?.default?.provider && snapshot?.model === models.body?.default?.model,
      JSON.stringify({ provider: snapshot?.provider, model: snapshot?.model }))
    check('快照带 configKey', typeof snapshot?.configKey === 'string' && snapshot.configKey.length >= 8, String(snapshot?.configKey))
    check('快照记录继承来源', snapshot?.inheritedFromProject === true)

    // ---- 未开始前可改配置
    const patched = await request(s.baseUrl, `/api/conversations/${conversationId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ skills: ['netcdf-analysis', 'gis-processing'] }),
    })
    check('未开始时允许修改对话配置', patched.status === 200, `status=${patched.status} ${JSON.stringify(patched.body)}`)
    check('修改后快照更新', (patched.body?.skills ?? []).includes('gis-processing'), JSON.stringify(patched.body?.skills))
    const reverted = await request(s.baseUrl, `/api/conversations/${conversationId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ skills: ['netcdf-analysis'] }),
    })
    check('改回单一技能', reverted.status === 200 && (reverted.body?.skills ?? []).length === 1, JSON.stringify(reverted.body?.skills))

    // ---- 发消息（模型调用 skill 工具）
    const events = await sendMessage(s.baseUrl, conversationId, '用 netcdf-analysis 技能说明如何分析长江口流场数据。')
    const types = events.map((event) => event.type)
    log(`  SSE：${types.join(' → ')}`)
    check('收到 message.started', types.includes('message.started'), types.join(','))
    check('收到 tool.started', types.includes('tool.started'), types.join(','))
    const toolStarted = events.find((event) => event.type === 'tool.started')
    check('工具名是 skill', toolStarted?.data?.tool === 'skill', JSON.stringify(toolStarted?.data))
    check('tool.completed 成功', events.find((event) => event.type === 'tool.completed')?.data?.success === true, JSON.stringify(events.find((e) => e.type === 'tool.completed')?.data))
    const completed = events.filter((event) => event.type === 'message.completed')
    check('收到 message.completed 且带文本', completed.length > 0 && (completed.at(-1)?.data?.text ?? '').length > 0, JSON.stringify(completed.at(-1)?.data))
    check('没有 message.failed', !types.includes('message.failed'), JSON.stringify(events.find((e) => e.type === 'message.failed')?.data))

    // ---- 历史消息
    const messages = await request(s.baseUrl, `/api/conversations/${conversationId}/messages`)
    const rows = messages.body?.messages ?? []
    check('历史含 user + assistant', rows.length >= 2 && rows[0]?.role === 'user', JSON.stringify(rows.map((row) => row.role)))
    const assistant = rows.find((row) => row.role === 'assistant')
    check('assistant 消息带工具记录', Array.isArray(assistant?.toolCalls) && assistant.toolCalls.length > 0, JSON.stringify(assistant?.toolCalls))

    // ---- 开始后禁止改配置
    const frozen = await request(s.baseUrl, `/api/conversations/${conversationId}/config`, {
      method: 'PUT',
      body: JSON.stringify({ skills: ['gis-processing'] }),
    })
    check('已开始的对话改配置返回 409', frozen.status === 409 && frozen.body?.error?.code === 'CONVERSATION_STARTED', `status=${frozen.status} ${JSON.stringify(frozen.body)}`)

    // ---- 运行时复用：同配置第二个对话
    const second = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, title: '同配置对话' }),
    })
    check('创建同配置的第二对话', second.status === 201, `status=${second.status}`)
    const secondId = second.body?.conversationId
    // 真正在两个对话上各跑一轮，才谈得上"复用同一个运行时"
    const secondEvents = await sendMessage(s.baseUrl, secondId, '再简单总结一下流场数据的查看方式。')
    check('第二对话也能正常完成', secondEvents.some((event) => event.type === 'message.completed'),
      secondEvents.map((event) => event.type).join(','))
    const runtimes = await request(s.baseUrl, '/api/runtimes')
    const runtimeList = runtimes.body?.runtimes ?? []
    check('同配置只用一个运行时', runtimeList.length === 1, JSON.stringify(runtimeList.map((item) => ({ key: item.configKey, conversations: item.conversationCount }))))
    check('运行时承载两个对话', (runtimeList[0]?.conversationCount ?? 0) >= 2, JSON.stringify(runtimeList[0]))

    // ---- 列表与详情
    const list = await request(s.baseUrl, `/api/conversations?projectId=${encodeURIComponent(projectId)}&limit=20`)
    check('对话列表包含两个对话', (list.body?.conversations ?? []).length >= 2, JSON.stringify((list.body?.conversations ?? []).map((item) => item.id)))
    const detail = await request(s.baseUrl, `/api/conversations/${conversationId}`)
    check('对话详情状态 idle', detail.body?.status === 'idle', JSON.stringify(detail.body?.status))
    check('对话详情消息数 > 0', (detail.body?.messageCount ?? 0) > 0, String(detail.body?.messageCount))
    check('快照带能力版本', typeof detail.body?.config?.capabilityRevision === 'string' && detail.body.config.capabilityRevision.length > 0,
      JSON.stringify(detail.body?.config?.capabilityRevision))

    // ---- 重命名
    const renamed = await request(s.baseUrl, `/api/conversations/${conversationId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title: '重命名后的对话' }),
    })
    check('PATCH 重命名成功', renamed.status === 200 && renamed.body?.title === '重命名后的对话', `status=${renamed.status} ${JSON.stringify(renamed.body?.title)}`)

    // ---- 停止（idle 对话 → 不误杀运行时）
    const stopped = await request(s.baseUrl, `/api/conversations/${conversationId}/stop`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
    check('对空闲对话调用 stop 返回 runtimeClosed=false',
      stopped.status === 200 && stopped.body?.runtimeClosed === false,
      `status=${stopped.status} ${JSON.stringify(stopped.body)}`)

    // ---- 删除（第二对话）
    const deleted = await request(s.baseUrl, `/api/conversations/${secondId}`, { method: 'DELETE' })
    check('DELETE 对话返回 204', deleted.status === 204, `status=${deleted.status}`)
    const gone = await request(s.baseUrl, `/api/conversations/${secondId}`)
    check('删除后查询返回 404', gone.status === 404, `status=${gone.status}`)

    // ---- 既有 DSH 配置来源（测试环境未配置 → enabled=false）
    const dshSource = await request(s.baseUrl, '/api/dsh-source')
    check('GET /api/dsh-source 可用且未启用', dshSource.status === 200 && dshSource.body?.enabled === false,
      `status=${dshSource.status} ${JSON.stringify(dshSource.body)}`)
  } catch (error) {
    failures.push(`阶段 A 异常：${error?.stack ?? error}`)
    log(`  ✗ 异常：${error?.message ?? error}`)
  } finally {
    const stderr = s.stderr()
    if (stderr.trim().length > 0 && stderr.includes('ERROR')) log(`  服务 stderr 片段：${stderr.slice(-600)}`)
    await s.stop()
  }
}

/* ------------------------------------------------------------------ 阶段 B */

async function phaseB() {
  log('')
  log('=== 阶段 B：MCP 工具、配置隔离、不同配置不同运行时 ===')
  const s = await boot('b', {
    port: 8796,
    // 两个对话各跑一轮：每轮都要求一次 MCP 工具调用
    sequence: ['tool_call_success', 'success', 'tool_call_success', 'success'],
    toolName: 'mcp__data-center__search_dataset',
    toolArguments: JSON.stringify({ keyword: '流场' }),
    successText: '已通过数据中心检索到 ocean-flow-2026 流场数据集。',
  })
  try {
    const projectId = 'mcp-project'
    const withMcp = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, mcpServers: ['data-center'], skills: [], title: 'MCP 对话' }),
    })
    check('创建带 MCP 的对话', withMcp.status === 201, `status=${withMcp.status} ${JSON.stringify(withMcp.body)}`)
    const conversationId = withMcp.body?.conversationId
    check('快照包含 data-center', (withMcp.body?.config?.mcpServers ?? []).includes('data-center'), JSON.stringify(withMcp.body?.config?.mcpServers))

    // ---- MCP 连接测试与工具列表（不依赖发消息）
    const tested = await request(s.baseUrl, '/api/mcp-servers/data-center/test', {
      method: 'POST',
      body: JSON.stringify({ timeoutMs: 20000 }),
    })
    check('MCP 连接测试成功', tested.status === 200 && tested.body?.ok === true,
      `status=${tested.status} ${JSON.stringify(tested.body?.error ?? tested.body)}`)
    const toolNames = (tested.body?.tools ?? []).map((tool) => tool.name)
    check('MCP 工具列表含 search_dataset', toolNames.includes('search_dataset'), JSON.stringify(toolNames))
    check('MCP 握手返回协议版本', typeof tested.body?.protocolVersion === 'string' && tested.body.protocolVersion.length > 0,
      JSON.stringify(tested.body?.protocolVersion))
    const toolsOnly = await request(s.baseUrl, '/api/mcp-servers/data-center/tools')
    check('GET /api/mcp-servers/:id/tools 可用', toolsOnly.status === 200 && (toolsOnly.body?.tools ?? []).length > 0,
      `status=${toolsOnly.status}`)
    const unknownMcp = await request(s.baseUrl, '/api/mcp-servers/no-such/test', { method: 'POST', body: JSON.stringify({}) })
    check('未知 MCP 服务器返回 404', unknownMcp.status === 404, `status=${unknownMcp.status}`)

    const events = await sendMessage(s.baseUrl, conversationId, '帮我查一下流场数据。')
    const types = events.map((event) => event.type)
    log(`  SSE：${types.join(' → ')}`)
    const toolStarted = events.find((event) => event.type === 'tool.started')
    check('MCP 工具被调用', toolStarted?.data?.tool === 'mcp__data-center__search_dataset', JSON.stringify(toolStarted?.data))
    check('MCP 工具执行成功', events.find((event) => event.type === 'tool.completed')?.data?.success === true, JSON.stringify(events.find((e) => e.type === 'tool.completed')?.data))
    const mcpResult = events.find((event) => event.type === 'tool.completed')?.data
    check('tool.completed 带结构化结果', mcpResult?.result !== undefined && mcpResult.result !== null,
      JSON.stringify(mcpResult?.result).slice(0, 200))
    check('结构化结果含数据集匹配', Array.isArray(mcpResult?.result?.matches), JSON.stringify(mcpResult?.result)?.slice(0, 200))
    check('tool.completed 带文本结果', typeof mcpResult?.resultText === 'string' && mcpResult.resultText.length > 0,
      JSON.stringify(mcpResult?.resultText)?.slice(0, 120))
    check('本轮有 assistant 文本', (events.filter((event) => event.type === 'message.completed').at(-1)?.data?.text ?? '').length > 0)

    // ---- 不同配置：不挂 MCP 的对话
    const withoutMcp = await request(s.baseUrl, '/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId, inheritProjectConfig: false, skills: [], mcpServers: [], title: '无 MCP 对话' }),
    })
    check('创建不带 MCP 的对话', withoutMcp.status === 201, `status=${withoutMcp.status}`)
    const plainId = withoutMcp.body?.conversationId
    check('未继承项目配置时 skills 为空', (withoutMcp.body?.config?.skills ?? []).length === 0, JSON.stringify(withoutMcp.body?.config?.skills))
    check('两个对话的 configKey 不同', withMcp.body?.config?.configKey !== withoutMcp.body?.config?.configKey, `${withMcp.body?.config?.configKey} vs ${withoutMcp.body?.config?.configKey}`)

    // 不挂 MCP 时同名工具不存在 → 模型调用失败（这正好证明"能力是硬隔离"）
    const plainEvents = await sendMessage(s.baseUrl, plainId, '同样帮我查流场数据。')
    const plainResult = plainEvents.find((event) => event.type === 'tool.completed')
    check('未挂载 MCP 时该工具调用失败', plainResult?.data?.success === false, JSON.stringify(plainResult?.data))
    if (plainResult?.data?.error) log(`    失败原因：${String(plainResult.data.error).slice(0, 160)}`)

    const runtimes = await request(s.baseUrl, '/api/runtimes')
    const runtimeList = runtimes.body?.runtimes ?? []
    check('两个不同配置 → 两个运行时', runtimeList.length === 2, JSON.stringify(runtimeList.map((item) => ({ key: item.configKey, mcp: item.mcpServers }))))

    const mcpRuntime = runtimeList.find((item) => (item.mcpServers ?? []).includes('data-center'))
    check('MCP 运行时的 serverName 反映在运行信息里', mcpRuntime !== undefined, JSON.stringify(runtimeList.map((item) => item.mcpServers)))
  } catch (error) {
    failures.push(`阶段 B 异常：${error?.stack ?? error}`)
    log(`  ✗ 异常：${error?.message ?? error}`)
  } finally {
    const stderr = s.stderr()
    if (stderr.trim().length > 0 && stderr.includes('ERROR')) log(`  服务 stderr 片段：${stderr.slice(-600)}`)
    await s.stop()
  }
}

log(`仓库：${root}`)
for (const phase of phases) {
  if (phase === 'a') await phaseA()
  else if (phase === 'b') await phaseB()
  else {
    process.stderr.write(`未知阶段 ${phase}（可用 a / b）\n`)
    process.exit(2)
  }
}

log('')
log(failures.length === 0 ? `E2E PASSED（${assertions} 项断言）` : `E2E FAILED（${failures.length}/${assertions}）`)
for (const failure of failures) log(`  - ${failure}`)
process.exit(failures.length === 0 ? 0 : 1)
