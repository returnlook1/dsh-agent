/**
 * 对话状态：历史列表、当前对话、消息流与 SSE 事件归并。
 *
 * 只消费 `ServiceEvent` 的 5 个业务事件：
 * - `message.started`（user）：确认本地乐观用户气泡；
 * - `message.completed`：按 messageId 去重地追加助手气泡（同一轮可有多条）；
 * - `tool.started` / `tool.completed`：按 callId 归并到当前轮的助手消息；
 * - `message.failed`：可见错误并结束本轮。
 */
import type {
  ConversationDto,
  ConversationSummary,
  CreateConversationRequest,
  MessageDto,
  MessageRole,
  ServiceEvent,
  ToolCallRecord,
} from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import {
  AgentApiError,
  createConversation,
  describeApiError,
  getConversation,
  getMessages,
  isAbortError,
  listConversations,
  openMessageStream,
} from '../services/agent-api'
import { readServiceEventStream } from '../services/sse'

/** 聊天区展示用的消息（比 MessageDto 多出本地状态字段）。 */
export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  createdAt: number
  toolCalls: ToolCallRecord[]
  /** 本地乐观气泡：还没收到 `message.started` 确认。 */
  optimistic?: boolean
  /** 为承载工具调用而创建、且暂无正文的助手占位消息。 */
  placeholder?: boolean
  failed?: boolean
}

export interface SendResult {
  ok: boolean
  /** 客户端主动取消（例如切换对话），不是错误。 */
  aborted?: boolean
  error?: string
}

interface ActiveTurn {
  sawAssistantMessage: boolean
  sawFailure: boolean
}

export const useConversationStore = defineStore('conversation', () => {
  const current = ref<ConversationDto | null>(null)
  const messages = ref<ChatMessage[]>([])
  const history = ref<ConversationSummary[]>([])

  const loadedConversationId = ref<string | null>(null)
  const historyLoading = ref(false)
  const messagesLoading = ref(false)
  const creating = ref(false)
  const streaming = ref(false)

  const error = ref<string | null>(null)
  const errorCode = ref<string | null>(null)
  const historyError = ref<string | null>(null)
  const truncated = ref(false)

  /** 消息 / 工具卡片变化时自增，供聊天区滚动到底部。 */
  const activityTick = ref(0)

  let streamController: AbortController | null = null
  let localSeq = 0
  let loadSeq = 0
  let historySeq = 0
  let activeTurn: ActiveTurn | null = null

  const canSend = computed(() => current.value !== null && !streaming.value)
  const hasMessages = computed(() => messages.value.length > 0)

  function bumpActivity(): void {
    activityTick.value += 1
  }

  function clearError(): void {
    error.value = null
    errorCode.value = null
  }

  function fromMessageDto(message: MessageDto): ChatMessage {
    return {
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      toolCalls: message.toolCalls !== undefined ? message.toolCalls.map((call) => ({ ...call })) : [],
    }
  }

  function lastMessage(): ChatMessage | null {
    const index = messages.value.length - 1
    if (index < 0) return null
    return messages.value[index] ?? null
  }

  /** 工具事件归属于当前轮最后一条助手消息；没有就建一个占位。 */
  function ensureToolAnchor(at: number): ChatMessage {
    const last = lastMessage()
    if (last !== null && last.role === 'assistant') return last
    const placeholder: ChatMessage = {
      id: `local-assistant-${++localSeq}`,
      role: 'assistant',
      content: '',
      createdAt: at,
      toolCalls: [],
      placeholder: true,
    }
    messages.value.push(placeholder)
    return placeholder
  }

  function findToolCall(callId: string): { message: ChatMessage; call: ToolCallRecord } | null {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const message = messages.value[i]
      if (message === undefined) continue
      const call = message.toolCalls.find((item) => item.callId === callId)
      if (call !== undefined) return { message, call }
    }
    return null
  }

  function lastEmptyAssistantPlaceholder(): ChatMessage | null {
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const message = messages.value[i]
      if (message === undefined) continue
      if (message.role === 'assistant' && message.placeholder === true && message.content.length === 0) {
        return message
      }
    }
    return null
  }

  function applyEvent(event: ServiceEvent): void {
    switch (event.type) {
      case 'message.started': {
        if (event.role !== 'user') break
        for (let i = messages.value.length - 1; i >= 0; i -= 1) {
          const message = messages.value[i]
          if (message === undefined) continue
          if (message.role === 'user' && message.optimistic === true) {
            message.id = event.messageId
            message.optimistic = false
            message.createdAt = event.at
            break
          }
        }
        break
      }

      case 'message.completed': {
        const existing = messages.value.find((message) => message.id === event.messageId)
        if (existing !== undefined) {
          existing.content = event.text
          existing.placeholder = false
          break
        }
        const placeholder = lastEmptyAssistantPlaceholder()
        if (placeholder !== null) {
          placeholder.id = event.messageId
          placeholder.content = event.text
          placeholder.createdAt = event.at
          placeholder.placeholder = false
        } else {
          messages.value.push({
            id: event.messageId,
            role: 'assistant',
            content: event.text,
            createdAt: event.at,
            toolCalls: [],
          })
        }
        if (activeTurn !== null) activeTurn.sawAssistantMessage = true
        break
      }

      case 'tool.started': {
        const found = findToolCall(event.callId)
        if (found === null) {
          const anchor = ensureToolAnchor(event.at)
          anchor.toolCalls.push({
            callId: event.callId,
            tool: event.tool,
            argumentsPreview: event.argumentsPreview,
            status: 'running',
          })
        }
        break
      }

      case 'tool.completed': {
        const found = findToolCall(event.callId)
        const record: ToolCallRecord = {
          callId: event.callId,
          tool: event.tool,
          status: event.success ? 'succeeded' : 'failed',
          error: event.error,
          durationMs: event.durationMs,
        }
        if (found !== null) {
          Object.assign(found.call, record)
        } else {
          const anchor = ensureToolAnchor(event.at)
          anchor.toolCalls.push(record)
        }
        break
      }

      case 'message.failed': {
        error.value = event.message
        errorCode.value = event.code ?? null
        if (activeTurn !== null) activeTurn.sawFailure = true
        const placeholder = lastEmptyAssistantPlaceholder()
        if (placeholder !== null && placeholder.toolCalls.length === 0) {
          messages.value = messages.value.filter((message) => message !== placeholder)
        }
        const last = lastMessage()
        if (last !== null && last.role === 'assistant') last.failed = true
        if (current.value !== null) current.value.status = 'failed'
        break
      }
    }
    bumpActivity()
  }

  function finalizeTurn(): void {
    // 去掉"既无正文又无工具"的空占位。
    messages.value = messages.value.filter(
      (message) => message.placeholder !== true || message.toolCalls.length > 0 || message.content.length > 0,
    )

    // 本轮结束时仍未收到 tool.completed 的调用不能一直转圈。
    for (const message of messages.value) {
      for (const call of message.toolCalls) {
        if (call.status === 'running') {
          call.status = 'failed'
          call.error = call.error ?? '本轮结束时未收到工具结果'
        }
      }
    }

    if (activeTurn !== null && !activeTurn.sawAssistantMessage && !activeTurn.sawFailure) {
      error.value = '本轮没有收到助手消息，连接可能已中断；请重试或刷新历史。'
      errorCode.value = 'STREAM_INTERRUPTED'
      if (current.value !== null) current.value.status = 'failed'
    }

    const conversation = current.value
    if (conversation !== null) {
      if (conversation.status !== 'failed') conversation.status = 'idle'
      conversation.updatedAt = Date.now()
      conversation.messageCount = messages.value.filter(
        (message) => message.content.length > 0 || message.toolCalls.length > 0,
      ).length
    }
    activeTurn = null
    bumpActivity()
  }

  async function refreshConversationMeta(conversationId: string): Promise<void> {
    try {
      const fresh = await getConversation(conversationId)
      if (current.value !== null && current.value.id === conversationId && !streaming.value) {
        current.value = fresh
      }
    } catch {
      // 元数据刷新失败不影响已渲染的消息；状态保持本地推断值。
    }
  }

  async function loadHistory(projectId?: string): Promise<void> {
    const seq = ++historySeq
    historyLoading.value = true
    historyError.value = null
    try {
      const list = await listConversations({
        projectId: projectId !== undefined && projectId.trim().length > 0 ? projectId.trim() : undefined,
        limit: 50,
      })
      if (seq !== historySeq) return
      history.value = list
    } catch (err) {
      if (seq !== historySeq) return
      historyError.value = `历史对话加载失败：${describeApiError(err)}`
    } finally {
      if (seq === historySeq) historyLoading.value = false
    }
  }

  async function loadConversation(conversationId: string): Promise<void> {
    const seq = ++loadSeq
    abortTurn()
    current.value = null
    messages.value = []
    loadedConversationId.value = null
    error.value = null
    errorCode.value = null
    truncated.value = false
    messagesLoading.value = true

    try {
      const [conversation, messageList] = await Promise.all([
        getConversation(conversationId),
        getMessages(conversationId),
      ])
      if (seq !== loadSeq) return
      current.value = conversation
      loadedConversationId.value = conversationId
      messages.value = messageList.messages
        .slice()
        .sort((a, b) => a.sequence - b.sequence)
        .map(fromMessageDto)
      truncated.value = messageList.truncated === true
      bumpActivity()
    } catch (err) {
      if (seq !== loadSeq) return
      error.value =
        err instanceof AgentApiError && err.code === 'NOT_FOUND'
          ? '对话不存在或已被删除'
          : `加载对话失败：${describeApiError(err)}`
      errorCode.value = err instanceof AgentApiError ? err.code : null
    } finally {
      if (seq === loadSeq) messagesLoading.value = false
    }
  }

  async function ensureConversation(conversationId: string): Promise<void> {
    if (loadedConversationId.value === conversationId && current.value?.id === conversationId) return
    await loadConversation(conversationId)
  }

  async function reloadConversation(): Promise<void> {
    const id = current.value?.id ?? loadedConversationId.value
    if (id === null) return
    await loadConversation(id)
  }

  function resetSession(): void {
    abortTurn()
    loadSeq += 1
    current.value = null
    messages.value = []
    loadedConversationId.value = null
    error.value = null
    errorCode.value = null
    truncated.value = false
    messagesLoading.value = false
  }

  async function create(payload: CreateConversationRequest): Promise<ConversationDto | null> {
    if (creating.value) return null
    // 正常情况下 UI 已确认过；这里兜底避免旧流的事件落到新对话上。
    abortTurn()
    creating.value = true
    error.value = null
    errorCode.value = null
    try {
      const created = await createConversation(payload)
      const now = Date.now()
      const conversation: ConversationDto = {
        id: created.conversationId,
        projectId: payload.projectId,
        sessionId: created.sessionId,
        config: created.config,
        status: 'idle',
        title: payload.title ?? '',
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      }
      current.value = conversation
      loadedConversationId.value = conversation.id
      messages.value = []
      truncated.value = false
      bumpActivity()
      return conversation
    } catch (err) {
      error.value = `创建对话失败：${describeApiError(err)}`
      errorCode.value = err instanceof AgentApiError ? err.code : null
      return null
    } finally {
      creating.value = false
    }
  }

  function abortTurn(): void {
    if (streamController !== null) {
      streamController.abort()
      streamController = null
    }
    streaming.value = false
  }

  async function send(rawContent: string): Promise<SendResult> {
    const conversation = current.value
    if (conversation === null) return { ok: false, error: '当前没有选中的对话' }
    if (streaming.value) return { ok: false, error: '本轮仍在运行，请稍候' }
    const content = rawContent.trim()
    if (content.length === 0) return { ok: false, error: '消息不能为空' }

    const conversationId = conversation.id
    error.value = null
    errorCode.value = null
    streaming.value = true
    conversation.status = 'running'
    activeTurn = { sawAssistantMessage: false, sawFailure: false }

    const optimistic: ChatMessage = {
      id: `local-user-${++localSeq}`,
      role: 'user',
      content,
      createdAt: Date.now(),
      toolCalls: [],
      optimistic: true,
    }
    messages.value.push(optimistic)
    bumpActivity()

    const controller = new AbortController()
    streamController = controller
    let receivedAnyEvent = false
    let aborted = false

    try {
      const stream = await openMessageStream(conversationId, content, controller.signal)
      await readServiceEventStream(stream, (event) => {
        if (event.conversationId !== conversationId) return
        receivedAnyEvent = true
        applyEvent(event)
      })
    } catch (err) {
      if (
        isAbortError(err) ||
        (err instanceof AgentApiError && err.code === 'ABORTED') ||
        controller.signal.aborted
      ) {
        aborted = true
      } else if (receivedAnyEvent) {
        error.value = `本轮事件流中断：${describeApiError(err)}`
        errorCode.value = err instanceof AgentApiError ? err.code : 'STREAM_INTERRUPTED'
        if (current.value !== null) current.value.status = 'failed'
      } else {
        // 还没收到任何事件：回滚乐观气泡，错误交给 Banner / 调用方决定是否恢复草稿。
        messages.value = messages.value.filter((message) => message.id !== optimistic.id)
        error.value = sendErrorMessage(err)
        errorCode.value = err instanceof AgentApiError ? err.code : null
        if (current.value !== null) current.value.status = 'failed'
        activeTurn = null
        bumpActivity()
        return { ok: false, error: error.value }
      }
    } finally {
      if (streamController === controller) streamController = null
      streaming.value = false
      if (!aborted) {
        finalizeTurn()
        void refreshConversationMeta(conversationId)
      } else {
        activeTurn = null
        bumpActivity()
      }
    }

    if (aborted) return { ok: false, aborted: true }
    return { ok: true }
  }

  function sendErrorMessage(error_: unknown): string {
    if (error_ instanceof AgentApiError) {
      switch (error_.code) {
        case 'CONVERSATION_RUNNING':
          return '该对话正在运行，请等待本轮结束后再发送'
        case 'NOT_FOUND':
          return '对话不存在或已被删除'
        case 'NETWORK_ERROR':
          return error_.message
        default:
          return `发送失败：${error_.message}`
      }
    }
    return `发送失败：${describeApiError(error_)}`
  }

  return {
    current,
    messages,
    history,
    loadedConversationId,
    historyLoading,
    messagesLoading,
    creating,
    streaming,
    error,
    errorCode,
    historyError,
    truncated,
    activityTick,
    canSend,
    hasMessages,
    clearError,
    loadHistory,
    loadConversation,
    ensureConversation,
    reloadConversation,
    resetSession,
    create,
    send,
    abortTurn,
  }
})
