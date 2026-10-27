<script setup lang="ts">
import type { CreateConversationRequest } from '@agent-studio/shared'
import { Button, Modal } from '@aifuxi/semi-ui-vue'
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

/** 三栏面板：窄屏默认收起右栏，小屏再收起左栏（可用顶栏按钮切换）。 */
const railOpen = ref(window.innerWidth >= 1024)
const inspectorOpen = ref(window.innerWidth >= 1280)

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

/** 顶栏的项目 / 路由摘要：只做展示，真正编辑在右栏。 */
const projectLabel = computed(() => {
  const id = conversation.current?.projectId ?? config.projectId
  return id.trim().length > 0 ? id : '未选择'
})

const routeProvider = computed(() => {
  const snapshot = conversation.current?.config
  if (snapshot !== undefined && snapshot.provider.length > 0) return snapshot.provider
  return config.dshRoute.provider.length > 0 ? config.dshRoute.provider : 'route'
})

/** 唤起 DSH 桌面端：自定义协议由 DSH 安装时注册（默认 dsh://open）。 */
const dshDeepLink = computed(() => config.dshApp?.deepLink ?? 'dsh://open')
const dshOffline = computed(() => {
  const app = config.dshApp
  return app !== null && app.guiUrl.trim().length > 0 && !app.guiReachable
})
const dshHint = computed(
  () => config.dshApp?.hint ?? '通过 dsh://open 唤起 DeepSeek Harness；模型、Provider、凭据都在 DSH 里配置。',
)

const routeModel = computed(() => {
  const snapshot = conversation.current?.config
  if (snapshot !== undefined && snapshot.model.length > 0) return snapshot.model
  return config.dshRoute.model.length > 0 ? config.dshRoute.model : '等待 DSH 清单'
})

const routeTitle = computed(() => {
  const catalog = config.modelCatalog
  if (catalog === null) return '模型清单尚未加载'
  const source = catalog.defaultSource === 'dsh-default-model' ? 'DSH 默认模型' : 'DSH 清单第一项'
  return `路由由 DSH 提供（${source}）· 来源 ${catalog.source}`
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
  void config.loadDshApp()
  void config.loadCapabilitySources()
  void conversation.loadHistory(historyProjectId())
})

onBeforeUnmount(() => {
  ui.stopHealthPolling()
  conversation.abortTurn()
})

function openConversation(conversationId: string): void {
  void router.push({ name: 'conversation', params: { conversationId } }).catch(() => undefined)
}

/** 历史列表跟随当前对话所属项目；没有对话时用右栏项目 ID。 */
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
    ui.notifyError('请先在右侧填写项目 ID')
    inspectorOpen.value = true
    return
  }
  if (!config.hasUsableModel) {
    ui.notifyError('DSH 没有报告可用的模型，无法新建对话')
    inspectorOpen.value = true
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
    // 右栏表单已经是完整选择；不继承项目默认，避免"取消勾选的技能被并集加回"。
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
  <div class="app-shell">
    <header class="topbar">
      <button type="button" class="brand" @click="requestHome">
        <span class="brand__mark" aria-hidden="true">DS</span>
        <span class="brand__text">
          <span class="brand__name">Agent Playground</span>
          <span class="brand__sub">DSH · Restricted Agent Service</span>
        </span>
      </button>

      <div class="topbar__group">
        <span class="chip chip--project" :title="`项目 ${projectLabel}`">
          <span class="chip__kicker">project</span>
          <span class="chip__value">{{ projectLabel }}</span>
        </span>
        <span class="chip chip--route" :title="routeTitle">
          <span class="chip__dot" aria-hidden="true" />
          <span class="chip__kicker">{{ routeProvider }}</span>
          <span class="chip__value">{{ routeModel }}</span>
        </span>
      </div>

      <div class="topbar__spacer" />

      <div class="topbar__group">
        <a class="chip chip--dsh" :href="dshDeepLink" :title="dshHint">
          <span class="chip__dot" :class="{ 'is-off': dshOffline }" aria-hidden="true" />
          <span class="chip__value">打开 DSH</span>
        </a>
        <StatusBadge :tone="healthTone" :label="healthLabel" :hint="healthHint" />
        <Button v-if="ui.health === 'offline'" size="small" theme="borderless" @click="ui.checkHealth()">
          重试
        </Button>
        <button
          type="button"
          class="panel-toggle"
          :class="{ 'is-active': railOpen }"
          title="会话栏"
          aria-label="切换会话栏"
          @click="railOpen = !railOpen"
        >
          ☰
        </button>
        <button
          type="button"
          class="panel-toggle"
          :class="{ 'is-active': inspectorOpen }"
          title="能力配置"
          aria-label="切换能力配置面板"
          @click="inspectorOpen = !inspectorOpen"
        >
          ⚙
        </button>
      </div>
    </header>

    <div
      class="workspace"
      :class="{ 'is-rail-closed': !railOpen, 'is-inspector-closed': !inspectorOpen }"
    >
      <aside class="rail panel">
        <div class="panel__head">
          <div>
            <p class="panel__eyebrow">sessions</p>
            <h2 class="panel__title">会话</h2>
          </div>
          <div class="panel__actions">
            <Button
              size="small"
              theme="borderless"
              :loading="conversation.historyLoading"
              @click="refreshHistory"
            >
              刷新
            </Button>
          </div>
        </div>

        <button
          type="button"
          class="rail__create"
          :disabled="conversation.creating || !config.hasUsableModel"
          :title="conversation.creating ? '正在创建…' : '按右侧当前选择创建对话'"
          @click="requestCreate"
        >
          <span>{{ conversation.creating ? '创建中…' : '新建对话' }}</span>
          <span class="rail__create-plus" aria-hidden="true">＋</span>
        </button>
        <p class="rail__create-hint">使用右侧当前选择（Skills / MCP / 模型）</p>

        <ConversationList
          :items="conversation.history"
          :active-id="conversation.current?.id ?? null"
          :loading="conversation.historyLoading"
          :error="conversation.historyError"
          @select="requestSwitch"
          @refresh="refreshHistory"
        />

        <ConversationMeta />
      </aside>

      <main class="stage panel">
        <ChatPanel @create="requestCreate" />
      </main>

      <aside class="inspector panel">
        <ConfigPanel />
      </aside>
    </div>
  </div>

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
