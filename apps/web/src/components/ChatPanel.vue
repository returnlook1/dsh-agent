<script setup lang="ts">
import type { AgentSummary } from '@agent-studio/shared'
import { Banner, Button, Spin, TextArea } from '@aifuxi/semi-ui-vue'
import { computed, nextTick, ref, watch } from 'vue'

import ApprovalDialog from '@/components/ApprovalDialog.vue'
import ToolCallCard from '@/components/ToolCallCard.vue'
import { notifyError, notifyInfo } from '@/services/feedback'
import { useChatStore, type ApprovalChoice, type ChatMessage } from '@/stores/chat'
import { formatClock } from '@/utils/format'
import { IconSend, IconStop } from '@/ui/icons'

const props = withDefaults(
  defineProps<{
    agent: AgentSummary | null
    welcome?: string
    modelLabel?: string
    showToolCalls?: boolean
  }>(),
  { welcome: '', modelLabel: '', showToolCalls: true },
)

const chat = useChatStore()
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)

const canSend = computed(
  () => draft.value.trim().length > 0 && !chat.streaming && props.agent !== null,
)

const showWelcome = computed(() => chat.messages.length === 0 && !chat.messagesLoading)

const welcomeText = computed(() =>
  props.welcome.trim().length > 0
    ? props.welcome
    : '输入你的问题。助手只会在被授权的工具范围内查询数据，遇到需要确认的操作会先弹出审批。',
)

function roleLabel(role: ChatMessage['role']): string {
  switch (role) {
    case 'user':
      return '我'
    case 'assistant':
      return '助手'
    case 'system':
      return '系统'
    default:
      return '工具'
  }
}

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element === null) return
  element.scrollTop = element.scrollHeight
}

watch(
  () => chat.activitySignal,
  () => {
    void scrollToBottom()
  },
)
watch(
  () => chat.messagesLoading,
  (loading) => {
    if (!loading) void scrollToBottom()
  },
)

async function submit(): Promise<void> {
  if (!canSend.value) return
  const content = draft.value
  draft.value = ''
  try {
    await chat.send(content)
  } catch (error) {
    notifyError(error)
    draft.value = content
  }
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
}

async function stop(): Promise<void> {
  await chat.stop()
  notifyInfo('已停止本轮运行')
}

async function decide(choice: ApprovalChoice): Promise<void> {
  try {
    await chat.decideApproval(choice)
  } catch (error) {
    notifyError(error)
  }
}

function expireApproval(): void {
  chat.expireApproval()
  notifyInfo('审批已超时，本次工具调用被拒绝')
}
</script>

<template>
  <section class="chat-panel">
    <header class="chat-panel__header">
      <div class="chat-panel__identity">
        <h2 class="chat-panel__name">{{ agent?.name ?? '未选择智能体' }}</h2>
        <p class="chat-panel__sub">
          <span v-if="agent">{{ agent.description || '受限智能体' }}</span>
          <span v-else>请先在左侧选择已发布的智能体</span>
        </p>
      </div>
      <div class="chat-panel__meta">
        <span v-if="modelLabel" class="chat-panel__model">{{ modelLabel }}</span>
        <span v-if="chat.streaming" class="chat-panel__running">
          <span class="dot dot--pulse" aria-hidden="true" />
          运行中
        </span>
      </div>
    </header>

    <div ref="scroller" class="chat-scroll">
      <div class="chat-column">
        <Banner
          v-if="chat.error"
          type="danger"
          :title="'本轮运行未完成'"
          class="chat-error"
          @close="chat.clearError()"
        >
          <template #description>{{ chat.error }}</template>
        </Banner>

        <div v-if="chat.messagesLoading" class="chat-loading">
          <Spin size="middle" />
        </div>

        <div v-else-if="showWelcome" class="chat-welcome">
          <div class="chat-welcome__mark" aria-hidden="true">AS</div>
          <h3 class="chat-welcome__title">{{ welcomeText }}</h3>
          <ul class="chat-welcome__points">
            <li>工具调用、审批与结果都会写入审计日志。</li>
            <li>需要确认的操作会暂停并等待你的授权。</li>
            <li>出网范围由 Agent 的出网策略与 MCP 白名单共同决定。</li>
          </ul>
        </div>

        <div v-else class="chat-messages">
          <article
            v-for="message in chat.messages"
            :key="message.id"
            class="msg"
            :class="[`msg--${message.role}`, { 'msg--failed': message.failed === true }]"
          >
            <div class="msg__meta">
              <span class="msg__role">{{ roleLabel(message.role) }}</span>
              <span class="msg__time">{{ formatClock(message.createdAt) }}</span>
            </div>
            <div class="msg__body">
              <div v-if="message.toolCalls.length > 0 && props.showToolCalls" class="msg__tools">
                <ToolCallCard v-for="call in message.toolCalls" :key="call.callId" :call="call" />
              </div>
              <p
                v-else-if="message.toolCalls.length > 0 && !message.content"
                class="msg__thinking"
              >
                正在调用工具…
              </p>
              <p v-if="message.content.length > 0" class="msg__text">{{ message.content }}</p>
              <p v-else-if="message.streaming === true" class="msg__thinking">正在检索并组织回答…</p>
              <span v-if="message.streaming === true" class="msg__caret" aria-hidden="true" />
            </div>
          </article>
        </div>
      </div>
    </div>

    <div class="chat-composer">
      <div class="chat-composer__inner">
        <TextArea
          v-model="draft"
          class="chat-composer__input"
          placeholder="请输入需要查询的问题，Enter 发送，Shift + Enter 换行"
          :autosize="{ minRows: 1, maxRows: 6 }"
          :disabled="chat.streaming"
          :max-length="4000"
          @keydown="handleKeydown"
        />
        <div class="chat-composer__actions">
          <span class="chat-composer__hint">所有工具调用均受策略与审计约束</span>
          <Button
            v-if="chat.streaming"
            type="danger"
            theme="light"
            @click="stop"
          >
            <template #icon><IconStop /></template>
            停止
          </Button>
          <Button
            v-else
            type="primary"
            theme="solid"
            :disabled="!canSend"
            @click="submit"
          >
            <template #icon><IconSend /></template>
            发送
          </Button>
        </div>
      </div>
    </div>

    <ApprovalDialog
      :prompt="chat.pendingApproval"
      :submitting="chat.decidingApproval"
      @decide="decide"
      @expire="expireApproval"
    />
  </section>
</template>
