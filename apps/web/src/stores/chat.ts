/**
 * 聊天状态机：会话列表 + 事件流消费 + 审批挂起。
 *
 * SSE 事件在这里收敛为 UI 模型，组件只负责渲染，不解析协议。
 */
import type {
  AgentEvent,
  MessageDto,
  SessionDto,
  ToolCallRecord,
  ToolRisk,
} from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { approvalApi, sessionApi } from '@/services/agent-api'
import { isAbortedRequest } from '@/services/http'
import { streamSessionEvents } from '@/services/sse'

export type ChatToolStatus = 'running' | 'succeeded' | 'failed' | 'denied'

export interface ChatToolCall {
  callId: string
  tool: string
  argumentsPreview?: string
  status: ChatToolStatus
  error?: string
  durationMs?: number
  risk?: ToolRisk
  startedAt: number
  /** 关联的审批单号（ask 策略时会挂起等待）。 */
  approvalId?: string
}

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  toolCalls: ChatToolCall[]
  streaming?: boolean
  failed?: boolean
}

export interface ApprovalPrompt {
  approvalId: string
  tool: string
  description: string
  argumentsPreview: string
  expiresAt: number
  requestedAt: number
}

export type ApprovalChoice = 'allowed-once' | 'rejected'

let localSequence = 0
function localId(prefix: string): string {
  localSequence += 1
  return `${prefix}-${Date.now().toString(36)}-${localSequence}`
}

function mapToolCall(record: ToolCallRecord, fallbackAt: number): ChatToolCall {
  const call: ChatToolCall = {
    callId: record.callId,
    tool: record.tool,
    status: record.status,
    startedAt: fallbackAt,
  }
  if (record.argumentsPreview !== undefined) call.argumentsPreview = record.argumentsPreview
  if (record.error !== undefined) call.error = record.error
  if (record.durationMs !== undefined) call.durationMs = record.durationMs
  return call
}

function mapMessage(message: MessageDto): ChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    toolCalls: (message.toolCalls ?? []).map((call) => mapToolCall(call, message.createdAt)),
  }
}

function limitMessage(reason: 'max-turns' | 'rate-limit' | 'max-concurrent'): string {
  switch (reason) {
    case 'max-turns':
      return '本次请求已达到轮次上限，运行已停止。请拆分问题或联系管理员调整 maxTurns。'
    case 'rate-limit':
      return '已超出该 Agent 的小时请求上限，请稍后再试。'
    case 'max-concurrent':
      return '该 Agent 已有运行中的会话，请等待当前运行结束。'
    default:
      return '运行受限，已停止。'
  }
}

export const useChatStore = defineStore('chat', () => {
  const sessions = ref<SessionDto[]>([])
  const sessionsLoading = ref(false)
  const sessionsLoaded = ref(false)

  const activeAgentId = ref<string>('')
  const activeSessionId = ref<string>('')

  const messages = ref<ChatMessage[]>([])
  const messagesLoading = ref(false)
  const streaming = ref(false)
  const error = ref<string | null>(null)

  const pendingApproval = ref<ApprovalPrompt | null>(null)
  const decidingApproval = ref(false)

  /** 当前流的取消句柄，非响应式。 */
  let controller: AbortController | null = null
  /** 本轮流式回复的本地消息 id，用于增量追加。 */
  let streamingMessageId: string | null = null

  const sortedSessions = computed(() =>
    [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt),
  )
  const activeSession = computed(
    () => sessions.value.find((item) => item.id === activeSessionId.value) ?? null,
  )
  /** 供聊天面板监听自动滚动。 */
  const activitySignal = computed(() => {
    const last = messages.value[messages.value.length - 1]
    if (last === undefined) return 0
    return last.content.length * 31 + last.toolCalls.length * 7 + (last.streaming === true ? 1 : 0)
  })

  function resetConversation(): void {
    activeSessionId.value = ''
    messages.value = []
    pendingApproval.value = null
    error.value = null
  }

  async function loadSessions(agentId: string): Promise<void> {
    sessionsLoading.value = true
    try {
      const response = await sessionApi.list(agentId.length > 0 ? agentId : undefined)
      sessions.value = response.items
      sessionsLoaded.value = true
    } finally {
      sessionsLoading.value = false
    }
  }

  async function selectAgent(agentId: string): Promise<void> {
    if (activeAgentId.value === agentId && sessionsLoaded.value) return
    activeAgentId.value = agentId
    resetConversation()
    sessions.value = []
    sessionsLoaded.value = false
    if (agentId.length === 0) return
    await loadSessions(agentId)
    const first = sortedSessions.value[0]
    if (first !== undefined) await selectSession(first.id)
  }

  async function createSession(agentId: string, title?: string): Promise<SessionDto> {
    const payload = title !== undefined && title.trim().length > 0 ? { title: title.trim() } : {}
    const session = await sessionApi.create(agentId, payload)
    sessions.value = [session, ...sessions.value.filter((item) => item.id !== session.id)]
    activeSessionId.value = session.id
    messages.value = []
    sessionsLoaded.value = true
    return session
  }

  async function selectSession(sessionId: string): Promise<void> {
    if (activeSessionId.value === sessionId && messages.value.length > 0) return
    const session = sessions.value.find((item) => item.id === sessionId)
    if (session !== undefined && activeAgentId.value !== session.agentId) {
      activeAgentId.value = session.agentId
    }
    activeSessionId.value = sessionId
    pendingApproval.value = null
    error.value = null
    messagesLoading.value = true
    try {
      const response = await sessionApi.messages(sessionId)
      messages.value = response.items.map(mapMessage)
    } catch (loadError) {
      messages.value = []
      throw loadError
    } finally {
      messagesLoading.value = false
    }
  }

  function ensureStreamingMessage(): ChatMessage {
    const currentId = streamingMessageId
    if (currentId !== null) {
      const existing = messages.value.find((item) => item.id === currentId)
      if (existing !== undefined) return existing
    }
    const created: ChatMessage = {
      id: localId('assistant'),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      toolCalls: [],
      streaming: true,
    }
    streamingMessageId = created.id
    messages.value.push(created)
    return created
  }

  function findToolCall(callId: string): ChatToolCall | undefined {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index]
      if (message === undefined) continue
      const call = message.toolCalls.find((item) => item.callId === callId)
      if (call !== undefined) return call
    }
    return undefined
  }

  function findLastRunningCall(): ChatToolCall | undefined {
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index]
      if (message === undefined) continue
      for (let cursor = message.toolCalls.length - 1; cursor >= 0; cursor -= 1) {
        const call = message.toolCalls[cursor]
        if (call !== undefined && call.status === 'running') return call
      }
    }
    return undefined
  }

  function markApprovalDenied(approvalId: string): void {
    for (const message of messages.value) {
      for (const call of message.toolCalls) {
        if (call.approvalId === approvalId) {
          call.status = 'denied'
          call.error = '审批未通过，工具未执行'
        }
      }
    }
  }

  function applyEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'run.started': {
        streaming.value = true
        error.value = null
        break
      }
      case 'message.delta': {
        const message = ensureStreamingMessage()
        if (event.mode === 'message') message.content = event.text
        else message.content += event.text
        break
      }
      case 'tool.started': {
        const message = ensureStreamingMessage()
        const call: ChatToolCall = {
          callId: event.callId,
          tool: event.tool,
          status: 'running',
          startedAt: event.at,
        }
        if (event.argumentsPreview !== undefined) call.argumentsPreview = event.argumentsPreview
        if (event.risk !== undefined) call.risk = event.risk
        message.toolCalls.push(call)
        break
      }
      case 'tool.completed': {
        const call = findToolCall(event.callId)
        if (call === undefined) break
        call.status = event.success ? 'succeeded' : 'failed'
        if (event.error !== undefined) call.error = event.error
        if (event.durationMs !== undefined) call.durationMs = event.durationMs
        break
      }
      case 'approval.required': {
        const call = findLastRunningCall()
        if (call !== undefined) call.approvalId = event.approvalId
        pendingApproval.value = {
          approvalId: event.approvalId,
          tool: event.tool,
          description: event.description,
          argumentsPreview: event.argumentsPreview ?? '',
          expiresAt: event.expiresAt,
          requestedAt: event.at,
        }
        break
      }
      case 'approval.decided': {
        if (pendingApproval.value?.approvalId === event.approvalId) {
          pendingApproval.value = null
        }
        if (event.decision !== 'allowed-once') markApprovalDenied(event.approvalId)
        break
      }
      case 'agent.completed': {
        const message = ensureStreamingMessage()
        message.content = event.text
        message.streaming = false
        streaming.value = false
        streamingMessageId = null
        break
      }
      case 'agent.failed': {
        const message = ensureStreamingMessage()
        message.streaming = false
        message.failed = true
        if (message.content.length === 0) message.content = event.message
        error.value = event.message
        streaming.value = false
        streamingMessageId = null
        break
      }
      case 'run.limit': {
        error.value = limitMessage(event.reason)
        const message = ensureStreamingMessage()
        message.streaming = false
        streaming.value = false
        streamingMessageId = null
        break
      }
      default:
        break
    }
  }

  async function send(content: string): Promise<void> {
    const text = content.trim()
    if (text.length === 0 || streaming.value) return
    const agentId = activeAgentId.value
    if (agentId.length === 0) {
      error.value = '请先选择智能体'
      return
    }
    error.value = null

    let sessionId = activeSessionId.value
    if (sessionId.length === 0) {
      const session = await createSession(agentId, text.slice(0, 24))
      sessionId = session.id
    }

    messages.value.push({
      id: localId('user'),
      role: 'user',
      content: text,
      createdAt: Date.now(),
      toolCalls: [],
    })
    streamingMessageId = null
    ensureStreamingMessage()
    streaming.value = true
    const localController = new AbortController()
    controller = localController

    try {
      await streamSessionEvents(sessionId, text, {
        signal: localController.signal,
        onEvent: applyEvent,
      })
    } catch (streamError) {
      if (!isAbortedRequest(streamError)) {
        error.value = streamError instanceof Error ? streamError.message : '事件流中断'
        const message = ensureStreamingMessage()
        message.failed = true
        message.streaming = false
      }
    } finally {
      streaming.value = false
      controller = null
      streamingMessageId = null
      for (const message of messages.value) {
        if (message.streaming === true) message.streaming = false
      }
      void refreshSessions()
    }
  }

  async function refreshSessions(): Promise<void> {
    const agentId = activeAgentId.value
    if (agentId.length === 0) return
    try {
      const response = await sessionApi.list(agentId)
      sessions.value = response.items
    } catch {
      // 会话列表刷新失败不影响本轮结果展示。
    }
  }

  async function stop(): Promise<void> {
    const sessionId = activeSessionId.value
    controller?.abort()
    controller = null
    streaming.value = false
    for (const message of messages.value) {
      if (message.streaming === true) message.streaming = false
    }
    if (sessionId.length === 0) return
    try {
      await sessionApi.stop(sessionId)
    } catch {
      // 网关可能已经结束运行，忽略停止失败。
    }
  }

  async function decideApproval(choice: ApprovalChoice, reason?: string): Promise<void> {
    const prompt = pendingApproval.value
    if (prompt === null || decidingApproval.value) return
    decidingApproval.value = true
    try {
      await approvalApi.decide(prompt.approvalId, {
        decision: choice,
        ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
      })
      if (pendingApproval.value?.approvalId === prompt.approvalId) pendingApproval.value = null
    } finally {
      decidingApproval.value = false
    }
  }

  /** 审批超时：网关侧会自行拒绝，这里只关闭弹窗并提示。 */
  function expireApproval(): void {
    const prompt = pendingApproval.value
    if (prompt === null) return
    pendingApproval.value = null
    markApprovalDenied(prompt.approvalId)
  }

  function clearError(): void {
    error.value = null
  }

  function reset(): void {
    controller?.abort()
    controller = null
    streaming.value = false
    streamingMessageId = null
    sessions.value = []
    sessionsLoaded.value = false
    activeAgentId.value = ''
    resetConversation()
  }

  return {
    sessions,
    sortedSessions,
    sessionsLoading,
    activeAgentId,
    activeSessionId,
    activeSession,
    messages,
    messagesLoading,
    streaming,
    error,
    pendingApproval,
    decidingApproval,
    activitySignal,
    loadSessions,
    selectAgent,
    createSession,
    selectSession,
    send,
    stop,
    decideApproval,
    expireApproval,
    clearError,
    reset,
  }
})
