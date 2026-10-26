<script setup lang="ts">
import type { CreateConversationRequest } from '@agent-studio/shared'
import { Button, LayoutContent, LayoutHeader, Layout, Modal } from '@aifuxi/semi-ui-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import ChatPanel from '@/components/ChatPanel.vue'
import ConfigPanel from '@/components/ConfigPanel.vue'
import ConversationList from '@/components/ConversationList.vue'
import ConversationMeta from '@/components/ConversationMeta.vue'
import StatusBadge, { type StatusTone } from '@/components/StatusBadge.vue'
import { useConfigStore } from '@/stores/config'
import { useConversationStore } from '@/stores/conversation'
import { useUiStore } from '@/stores/ui'

type PendingAction =
  | { kind: 'switch'; conversationId: string }
  | { kind: 'create' }
  | { kind: 'home' }
  | null

const route = useRoute()
const router = useRouter()
const config = useConfigStore()
const conversation = useConversationStore()
const ui = useUiStore()

const pendingAction = ref<PendingAction>(null)
const switchConfirmVisible = computed(() => pendingAction.value !== null)

const healthTone = computed<StatusTone>(() => {
  if (ui.health === 'online') return 'online'
  if (ui.health === 'checking') return 'checking'
  return 'offline'
})

const healthLabel = computed(() => {
  if (ui.health === 'online') return '服务在线'
  if (ui.health === 'checking') return '检查连接…'
  return '服务不可用'
})

const healthHint = computed(() => {
  const info = ui.healthInfo
  if (ui.health === 'online') {
    const parts: string[] = []
    if (info?.version) parts.push(`service ${info.version}`)
    if (info?.dshVersion) parts.push(`dsh ${info.dshVersion}`)
    if (info?.runtimes !== undefined) parts.push(`${info.runtimes} 个运行时`)
    return parts.length > 0 ? parts.join(' · ') : 'GET /api/health 正常'
  }
  if (ui.health === 'checking') return '正在检查 GET /api/health'
  return 'GET /api/health 不可用：可继续查看页面，但请求可能失败。'
})

watch(
  () => route.params.conversationId,
  (value) => {
    const raw = Array.isArray(value) ? value[0] : value
    if (typeof raw === 'string' && raw.length > 0) {
      void conversation.ensureConversation(raw)
      return
    }
    conversation.resetSession()
  },
  { immediate: true },
)

watch(
  () => conversation.streaming,
  (value, previous) => {
    if (previous === true && value === false) {
      void conversation.loadHistory(historyProjectId())
    }
  },
)

onMounted(() => {
  ui.startHealthPolling()
  void config.loadCatalogs()
  void config.loadProjectConfig()
  void conversation.loadHistory(historyProjectId())
})

onBeforeUnmount(() => {
  ui.stopHealthPolling()
  conversation.abortTurn()
})

function openConversation(conversationId: string): void {
  void router.push({ name: 'conversation', params: { conversationId } }).catch(() => undefined)
}

/** 历史列表跟随当前对话所属项目；没有对话时用左栏项目 ID。 */
function historyProjectId(): string {
  return conversation.current?.projectId ?? config.projectId
}

function requestSwitch(conversationId: string): void {
  if (conversation.current?.id === conversationId) return
  if (conversation.streaming) {
    pendingAction.value = { kind: 'switch', conversationId }
    return
  }
  openConversation(conversationId)
}

function requestCreate(): void {
  if (conversation.creating) return
  if (conversation.streaming) {
    pendingAction.value = { kind: 'create' }
    return
  }
  void createNow()
}

function requestHome(): void {
  if (route.name === 'playground') return
  if (conversation.streaming) {
    pendingAction.value = { kind: 'home' }
    return
  }
  goHomeNow()
}

function goHomeNow(): void {
  conversation.resetSession()
  void router.push({ name: 'playground' }).catch(() => undefined)
}

async function createNow(): Promise<void> {
  const projectId = config.projectId.trim()
  if (projectId.length === 0) {
    ui.notifyError('请先填写项目 ID')
    return
  }
  if (!config.hasUsableModel) {
    ui.notifyError('DSH 没有报告可用的模型，无法新建对话')
    return
  }
  // 候选项来自 DSH；不选则由服务端用 DSH 默认路由（agent-default-model）。
  const provider = config.provider.trim()
  const model = config.model.trim()

  const payload: CreateConversationRequest = {
    projectId,
    skills: [...config.selectedSkills],
    mcpServers: [...config.selectedMcpServers],
    ...(provider.length === 0 || model.length === 0 ? {} : { provider, model }),
    systemPrompt: config.systemPrompt,
    // 左侧表单已经是完整选择；不继承项目默认，避免"取消勾选的技能被并集加回"。
    inheritProjectConfig: false,
  }

  const created = await conversation.create(payload)
  if (created === null) {
    ui.notifyError(conversation.error ?? '创建对话失败')
    return
  }

  if (route.params.conversationId !== created.id) {
    try {
      await router.push({ name: 'conversation', params: { conversationId: created.id } })
    } catch {
      // 导航失败不影响已创建的对话；下一次点击历史仍可进入。
    }
  }
  void conversation.loadHistory(historyProjectId())
}

function confirmPending(): void {
  const action = pendingAction.value
  pendingAction.value = null
  if (action === null) return
  conversation.abortTurn()
  if (action.kind === 'switch') {
    openConversation(action.conversationId)
  } else if (action.kind === 'create') {
    void createNow()
  } else {
    goHomeNow()
  }
}

function cancelPending(): void {
  pendingAction.value = null
}

function refreshHistory(): void {
  void conversation.loadHistory(historyProjectId())
}
</script>

<template>
  <Layout class="playground">
    <LayoutHeader class="playground__header">
      <button type="button" class="brand" @click="requestHome">
        <span class="brand__mark" aria-hidden="true">AP</span>
        <span class="brand__text">
          <span class="brand__name">Agent Playground</span>
          <span class="brand__sub">DSH Agent Service · 本地能力测试台</span>
        </span>
      </button>

      <div class="playground__header-right">
        <StatusBadge :tone="healthTone" :label="healthLabel" :hint="healthHint" />
        <Button v-if="ui.health === 'offline'" size="small" theme="borderless" @click="ui.checkHealth()">
          重试
        </Button>
      </div>
    </LayoutHeader>

    <LayoutContent class="playground__body">
      <aside class="playground__aside">
        <ConfigPanel @create="requestCreate" />
        <ConversationMeta />
        <ConversationList
          :items="conversation.history"
          :active-id="conversation.current?.id ?? null"
          :loading="conversation.historyLoading"
          :error="conversation.historyError"
          @select="requestSwitch"
          @refresh="refreshHistory"        />
      </aside>

      <div class="playground__main">
        <ChatPanel />
      </div>
    </LayoutContent>
  </Layout>

  <Modal
    :visible="switchConfirmVisible"
    title="当前对话仍在运行"
    ok-text="仍然切换"
    cancel-text="留在此页"
    @ok="confirmPending"
    @cancel="cancelPending"
  >
    <p class="confirm-note">
      本轮仍会在服务端继续执行并写入历史，但切换后将不再接收实时事件；稍后可在历史对话里刷新查看结果。
    </p>
  </Modal>
</template>
