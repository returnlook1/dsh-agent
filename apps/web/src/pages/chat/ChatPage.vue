<script setup lang="ts">
import type { UiConfig } from '@agent-studio/shared'
import { Banner, Button, Spin } from '@aifuxi/semi-ui-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AgentSelector from '@/components/AgentSelector.vue'
import ChatPanel from '@/components/ChatPanel.vue'
import EmptyState from '@/components/EmptyState.vue'
import { agentApi } from '@/services/agent-api'
import { notifyError, notifySuccess, notifyWarning } from '@/services/feedback'
import { useAgentsStore } from '@/stores/agents'
import { useChatStore } from '@/stores/chat'
import { formatRelative } from '@/utils/format'
import { IconPlus } from '@/ui/icons'

const route = useRoute()
const router = useRouter()
const agents = useAgentsStore()
const chat = useChatStore()

const welcome = ref('')
const agentUi = ref<UiConfig | null>(null)
const creating = ref(false)
const booting = ref(true)

const published = computed(() => agents.items.filter((item) => item.status === 'published'))
const selectedAgent = computed(
  () => published.value.find((item) => item.id === chat.activeAgentId) ?? null,
)
const modelLabel = computed(() => {
  const agent = selectedAgent.value
  return agent === null ? '' : `${agent.provider} / ${agent.model}`
})
const showToolCalls = computed(() => agentUi.value?.showToolCalls ?? true)

async function loadWelcome(agentId: string): Promise<void> {
  welcome.value = ''
  agentUi.value = null
  try {
    const detail = await agentApi.get(agentId)
    welcome.value = detail.draft.prompt.welcome
    agentUi.value = detail.draft.ui
  } catch {
    // 普通用户可能没有详情权限：欢迎语退化为通用文案。
    welcome.value = ''
  }
}

async function selectAgent(agentId: string): Promise<void> {
  if (agentId.length === 0) return
  try {
    await chat.selectAgent(agentId)
    if (route.params.agentId !== agentId) {
      await router.replace({ name: 'chat', params: { agentId } })
    }
    await loadWelcome(agentId)
  } catch (error) {
    notifyError(error, '加载会话失败')
  }
}

async function bootstrap(): Promise<void> {
  booting.value = true
  try {
    await agents.fetchList()
  } catch (error) {
    notifyError(error, '加载智能体列表失败')
  }
  const requested = typeof route.params.agentId === 'string' ? route.params.agentId : ''
  const target =
    published.value.find((item) => item.id === requested) ??
    published.value[0] ??
    null
  if (target !== null) {
    await selectAgent(target.id)
  }
  booting.value = false
}

onMounted(() => {
  void bootstrap()
})

watch(
  () => route.params.agentId,
  (next) => {
    if (typeof next === 'string' && next.length > 0 && next !== chat.activeAgentId) {
      void selectAgent(next)
    }
  },
)

async function createSession(): Promise<void> {
  const agent = selectedAgent.value
  if (agent === null) return
  creating.value = true
  try {
    await chat.createSession(agent.id)
    notifySuccess('已新建会话')
  } catch (error) {
    notifyError(error, '新建会话失败')
  } finally {
    creating.value = false
  }
}

async function selectSession(sessionId: string): Promise<void> {
  if (chat.streaming) {
    notifyWarning('请先停止当前运行，再切换会话')
    return
  }
  if (sessionId === chat.activeSessionId) return
  try {
    await chat.selectSession(sessionId)
  } catch (error) {
    notifyError(error, '加载会话消息失败')
  }
}
</script>

<template>
  <div class="chat-page">
    <aside class="chat-sidebar" aria-label="会话列表">
      <div class="chat-sidebar__head">
        <AgentSelector
          :agents="published"
          :model-value="chat.activeAgentId"
          :loading="agents.listLoading"
          :disabled="chat.streaming"
          @update:model-value="selectAgent"
        />
        <Button
          block
          type="primary"
          theme="light"
          :disabled="selectedAgent === null || chat.streaming"
          :loading="creating"
          @click="createSession"
        >
          <template #icon><IconPlus /></template>
          新建会话
        </Button>
        <Banner v-if="agents.listError" type="danger" :title="agents.listError" />
      </div>

      <div class="chat-sidebar__list">
        <span class="chat-sidebar__label">会话</span>
        <div v-if="booting || chat.sessionsLoading" class="chat-sidebar__empty">
          <Spin size="small" />
        </div>
        <p v-else-if="chat.sortedSessions.length === 0" class="chat-sidebar__empty">
          暂无会话。发送第一条消息会自动创建，并绑定当前 Agent 的已发布版本。
        </p>
        <button
          v-for="session in chat.sortedSessions"
          :key="session.id"
          type="button"
          class="session-item"
          :class="{ 'is-active': session.id === chat.activeSessionId }"
          @click="selectSession(session.id)"
        >
          <span class="session-item__title">
            <span>{{ session.title || '未命名会话' }}</span>
          </span>
          <span v-if="session.lastMessagePreview" class="session-item__preview">
            {{ session.lastMessagePreview }}
          </span>
          <span class="session-item__meta">
            <span>{{ formatRelative(session.updatedAt) }}</span>
            <span>v{{ session.agentVersion }}</span>
          </span>
        </button>
      </div>
    </aside>

    <div v-if="booting" class="chat-boot">
      <Spin size="large" tip="正在加载会话" />
    </div>

    <EmptyState
      v-else-if="published.length === 0"
      class="chat-empty"
      title="暂无可用的智能体"
      description="聊天入口只对已发布的 Agent 开放。请先在 Agent 管理中完成配置并发布。"
      action-label="前往 Agent 管理"
      @action="router.push({ name: 'agents' })"
    />

    <ChatPanel
      v-else
      :agent="selectedAgent"
      :welcome="welcome"
      :model-label="modelLabel"
      :show-tool-calls="showToolCalls"
    />
  </div>
</template>
