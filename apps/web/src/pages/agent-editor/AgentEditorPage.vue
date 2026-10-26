<script setup lang="ts">
import type {
  AgentConfig,
  AgentDetail,
  AgentVersionDto,
  ConfigWarning,
  UpdateAgentRequest,
} from '@agent-studio/shared'
import { Banner, Button, Popconfirm, Spin } from '@aifuxi/semi-ui-vue'
import type { Component } from 'vue'
import { computed, onMounted, ref } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'

import EmptyState from '@/components/EmptyState.vue'
import StatusTag from '@/components/StatusTag.vue'
import TabBasics from '@/pages/agent-editor/tabs/BasicsTab.vue'
import TabModel from '@/pages/agent-editor/tabs/ModelTab.vue'
import TabPermissions from '@/pages/agent-editor/tabs/PermissionsTab.vue'
import TabRelease from '@/pages/agent-editor/tabs/ReleaseTab.vue'
import TabSession from '@/pages/agent-editor/tabs/SessionTab.vue'
import TabTools from '@/pages/agent-editor/tabs/ToolsTab.vue'
import { messageOf, notifyError, notifySuccess } from '@/services/feedback'
import { useAgentsStore } from '@/stores/agents'
import { formatDateTime } from '@/utils/format'
import {
  IconAgents,
  IconBack,
  IconClock,
  IconPlay,
  IconShield,
  IconSliders,
  IconTool,
} from '@/ui/icons'

type TabKey = 'basics' | 'model' | 'tools' | 'permissions' | 'session' | 'release'

interface TabEntry {
  key: TabKey
  label: string
  icon: Component
}

const TABS: readonly TabEntry[] = [
  { key: 'basics', label: '基本信息', icon: IconAgents },
  { key: 'model', label: '模型设置', icon: IconSliders },
  { key: 'tools', label: '工具能力', icon: IconTool },
  { key: 'permissions', label: '权限管理', icon: IconShield },
  { key: 'session', label: '会话配置', icon: IconClock },
  { key: 'release', label: '测试与发布', icon: IconPlay },
]

function emptyConfig(): AgentConfig {
  return {
    id: '',
    name: '',
    description: '',
    status: 'draft',
    version: 1,
    model: { provider: 'deepseek-official', modelId: 'deepseek-v4-flash' },
    prompt: { system: '', welcome: '' },
    capabilities: { tools: {}, mcpServers: [], skills: [], subagents: false },
    security: {
      shell: false,
      fileRead: false,
      fileWrite: false,
      pluginManagement: false,
      networkAccess: 'restricted',
      dataScope: 'user-authorized',
    },
    limits: { maxTurns: 20, maxConcurrentRuns: 1, maxRequestsPerHour: 30 },
    ui: {
      showToolCalls: true,
      showReasoning: false,
      allowAttachments: false,
      showModelSelector: false,
    },
  }
}

function cloneConfig(config: AgentConfig): AgentConfig {
  return JSON.parse(JSON.stringify(config)) as AgentConfig
}

function toUpdateRequest(config: AgentConfig): UpdateAgentRequest {
  return {
    name: config.name,
    description: config.description,
    model: config.model,
    prompt: config.prompt,
    capabilities: config.capabilities,
    security: config.security,
    limits: config.limits,
    ui: config.ui,
  }
}

function validate(config: AgentConfig): Record<string, string> {
  const errors: Record<string, string> = {}
  if (config.name.trim().length === 0) errors.name = '请输入 Agent 名称'
  else if (config.name.trim().length > 80) errors.name = '名称不能超过 80 个字符'
  if (config.description.length > 400) errors.description = '描述不能超过 400 个字符'
  if (config.model.provider.trim().length === 0) errors['model.provider'] = '请填写 Provider'
  if (config.model.modelId.trim().length === 0) errors['model.modelId'] = '请填写模型 ID'
  const temperature = config.model.temperature
  if (temperature !== undefined && (temperature < 0 || temperature > 2)) {
    errors['model.temperature'] = 'temperature 需在 0 到 2 之间'
  }
  const maxOutputTokens = config.model.maxOutputTokens
  if (maxOutputTokens !== undefined && (maxOutputTokens < 1 || maxOutputTokens > 200_000)) {
    errors['model.maxOutputTokens'] = '最大输出 token 需在 1 到 200000 之间'
  }
  if (config.limits.maxTurns < 1 || config.limits.maxTurns > 200) {
    errors['limits.maxTurns'] = 'maxTurns 需在 1 到 200 之间'
  }
  if (config.limits.maxConcurrentRuns < 1 || config.limits.maxConcurrentRuns > 8) {
    errors['limits.maxConcurrentRuns'] = 'maxConcurrentRuns 需在 1 到 8 之间'
  }
  if (config.limits.maxRequestsPerHour < 1 || config.limits.maxRequestsPerHour > 10_000) {
    errors['limits.maxRequestsPerHour'] = 'maxRequestsPerHour 需在 1 到 10000 之间'
  }
  return errors
}

const route = useRoute()
const router = useRouter()
const agents = useAgentsStore()

const activeTab = ref<TabKey>('basics')
const draft = ref<AgentConfig>(emptyConfig())
const baseline = ref('')
const loaded = ref(false)
const loadError = ref('')
const saveError = ref('')
const publishError = ref('')
const lastPublished = ref<AgentVersionDto | null>(null)

const agentId = computed(() => String(route.params.id ?? ''))
const detail = computed<AgentDetail | null>(() => agents.detail)
const versionHistory = computed<AgentVersionDto[]>(() =>
  [...(detail.value?.versions ?? [])].sort((a, b) => b.version - a.version),
)
const latestVersion = computed<AgentVersionDto | null>(() => versionHistory.value[0] ?? null)
const activeWarnings = computed<ConfigWarning[]>(() => {
  if (lastPublished.value !== null) return lastPublished.value.warnings
  return latestVersion.value?.warnings ?? []
})
const validationErrors = computed<Record<string, string>>(() => validate(draft.value))
const isDirty = computed(
  () => loaded.value && JSON.stringify(toUpdateRequest(draft.value)) !== baseline.value,
)

const errorCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const key of Object.keys(validationErrors.value)) {
    const tab: TabKey = key.startsWith('model.')
      ? 'model'
      : key.startsWith('limits.')
        ? 'session'
        : 'basics'
    counts[tab] = (counts[tab] ?? 0) + 1
  }
  return counts
})

async function load(): Promise<void> {
  if (agentId.value.length === 0) return
  loadError.value = ''
  try {
    const loadedDetail = await agents.fetchDetail(agentId.value)
    draft.value = cloneConfig(loadedDetail.draft)
    baseline.value = JSON.stringify(toUpdateRequest(loadedDetail.draft))
    loaded.value = true
    lastPublished.value = null
    await agents.fetchTools(agentId.value)
  } catch (error) {
    loadError.value = messageOf(error, '加载 Agent 详情失败')
    loaded.value = false
  }
}

async function save(options?: { silent?: boolean }): Promise<boolean> {
  if (!loaded.value) return false
  const config = draft.value
  const errors = validate(config)
  if (Object.keys(errors).length > 0) {
    const firstKey = Object.keys(errors)[0] ?? ''
    activeTab.value = firstKey.startsWith('model.')
      ? 'model'
      : firstKey.startsWith('limits.')
        ? 'session'
        : 'basics'
    notifyError(new Error(errors[firstKey] ?? '配置校验未通过'))
    return false
  }
  saveError.value = ''
  try {
    const updated = await agents.saveAgent(agentId.value, toUpdateRequest(config))
    draft.value = cloneConfig(updated.draft)
    baseline.value = JSON.stringify(toUpdateRequest(updated.draft))
    if (options?.silent !== true) notifySuccess('草稿已保存')
    return true
  } catch (error) {
    saveError.value = messageOf(error, '保存失败')
    if (options?.silent !== true) notifyError(error, '保存失败')
    return false
  }
}

async function publish(): Promise<void> {
  publishError.value = ''
  if (!loaded.value) return
  if (isDirty.value) {
    const saved = await save({ silent: true })
    if (!saved) return
  }
  try {
    const version = await agents.publishAgent(agentId.value)
    lastPublished.value = version
    activeTab.value = 'release'
    if (version.warnings.length > 0) {
      notifySuccess(`已发布 v${version.version}，有 ${version.warnings.length} 项配置未能在运行时落实`)
    } else {
      notifySuccess(`已发布 v${version.version}，所有配置均已在运行时验证`)
    }
  } catch (error) {
    publishError.value = messageOf(error, '发布失败')
    notifyError(error, '发布失败')
  }
}

function selectTab(key: TabKey): void {
  activeTab.value = key
}

function openChat(): void {
  void router.push({ name: 'chat', params: { agentId: agentId.value } })
}

function backToList(): void {
  void router.push({ name: 'agents' })
}

onMounted(() => {
  void load()
})

onBeforeRouteLeave(() => {
  if (!isDirty.value) return true
  return window.confirm('当前配置尚未保存，确认离开？')
})
</script>

<template>
  <div class="page page--narrow">
    <div v-if="!loaded && agents.detailLoading" class="editor-section">
      <Spin size="large" tip="加载 Agent 配置" />
    </div>

    <EmptyState
      v-else-if="!loaded"
      title="无法加载该 Agent"
      :description="loadError || '该 Agent 可能已被删除，或当前账号没有访问权限。'"
      action-label="返回列表"
      @action="backToList"
    />

    <template v-else>
      <header class="editor-header">
        <div class="editor-header__main">
          <button type="button" class="editor-header__back" @click="backToList">
            <IconBack />
            <span>返回列表</span>
          </button>
          <div class="editor-header__title">
            <span>{{ draft.name || '未命名 Agent' }}</span>
            <StatusTag v-if="detail" kind="agent-status" :value="detail.status" />
            <span v-if="isDirty" class="editor-dirty">未保存</span>
          </div>
          <div class="editor-header__meta">
            <span>标识 {{ agentId }}</span>
            <span>草稿版本 v{{ detail?.version ?? draft.version }}</span>
            <span v-if="detail?.publishedVersion !== undefined">已发布 v{{ detail.publishedVersion }}</span>
            <span v-if="detail">更新于 {{ formatDateTime(detail.updatedAt) }}</span>
          </div>
        </div>
        <div class="editor-header__actions">
          <Button
            v-if="detail?.status === 'published'"
            theme="borderless"
            type="tertiary"
            @click="openChat"
          >
            进入聊天
          </Button>
          <Button :loading="agents.saving" :disabled="!isDirty" @click="save()">保存</Button>
          <Popconfirm
            title="确认发布新版本？"
            content="发布会冻结当前配置快照，并重新校验配置能否在运行时落实。"
            ok-text="发布"
            cancel-text="取消"
            @confirm="publish"
          >
            <Button type="primary" theme="solid" :loading="agents.publishing">发布</Button>
          </Popconfirm>
        </div>
      </header>

      <Banner v-if="saveError" type="danger" title="保存失败" @close="saveError = ''">
        <template #description>{{ saveError }}</template>
      </Banner>
      <Banner v-if="publishError" type="danger" title="发布失败" @close="publishError = ''">
        <template #description>{{ publishError }}</template>
      </Banner>

      <div class="editor-layout">
        <nav class="editor-nav" aria-label="配置导航">
          <button
            v-for="tab in TABS"
            :key="tab.key"
            type="button"
            class="editor-nav__item"
            :class="{ 'is-active': activeTab === tab.key }"
            :aria-current="activeTab === tab.key ? 'page' : undefined"
            @click="selectTab(tab.key)"
          >
            <span class="editor-nav__icon" aria-hidden="true"><component :is="tab.icon" /></span>
            <span>{{ tab.label }}</span>
            <span v-if="errorCounts[tab.key]" class="editor-nav__count">{{ errorCounts[tab.key] }}</span>
          </button>
        </nav>

        <div class="editor-content">
          <TabBasics v-if="activeTab === 'basics'" :draft="draft" :errors="validationErrors" />
          <TabModel
            v-else-if="activeTab === 'model'"
            :draft="draft"
            :errors="validationErrors"
            :warnings="activeWarnings"
          />
          <TabTools v-else-if="activeTab === 'tools'" :draft="draft" :agent-id="agentId" />
          <TabPermissions v-else-if="activeTab === 'permissions'" :draft="draft" />
          <TabSession v-else-if="activeTab === 'session'" :draft="draft" :errors="validationErrors" />
          <TabRelease
            v-else
            :draft="draft"
            :detail="detail"
            :versions="versionHistory"
            :last-published="lastPublished"
            :publishing="agents.publishing"
            :dirty="isDirty"
            @publish="publish"
            @save="save()"
          />
        </div>
      </div>
    </template>
  </div>
</template>
