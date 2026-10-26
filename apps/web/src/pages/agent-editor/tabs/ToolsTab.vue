<script setup lang="ts">
import type { AgentConfig, AgentToolsResponse } from '@agent-studio/shared'
import { Banner, Button, Select, Spin, Switch, Tag } from '@aifuxi/semi-ui-vue'
import { computed, onMounted } from 'vue'

import EmptyState from '@/components/EmptyState.vue'
import StatusTag from '@/components/StatusTag.vue'
import { useAgentsStore } from '@/stores/agents'
import { TOOL_SOURCE_ORDER } from '@/utils/labels'
import { IconRefresh, IconWarning } from '@/ui/icons'

type ToolRow = AgentToolsResponse['tools'][number]

const props = defineProps<{
  draft: AgentConfig
  agentId: string
}>()

const agents = useAgentsStore()

const response = computed<AgentToolsResponse | null>(() => agents.tools)
const tools = computed<ToolRow[]>(() => response.value?.tools ?? [])
const blocked = computed<string[]>(() => response.value?.blockedCapabilities ?? [])

const groups = computed(() =>
  TOOL_SOURCE_ORDER.map((group) => ({
    ...group,
    items: tools.value.filter((tool) => tool.source === group.source),
  })).filter((group) => group.items.length > 0),
)

const ACTION_OPTIONS = [
  { value: 'allow', label: 'allow — 直接执行' },
  { value: 'ask', label: 'ask — 需审批' },
  { value: 'deny', label: 'deny — 禁止' },
]

const authorizedCount = computed(() => {
  let count = 0
  for (const value of Object.values(props.draft.capabilities.tools)) {
    if (value === 'allow' || value === 'ask') count += 1
  }
  return count
})

function actionFor(name: string): 'allow' | 'ask' | 'deny' {
  return props.draft.capabilities.tools[name] ?? 'deny'
}

function isExplicit(name: string): boolean {
  return props.draft.capabilities.tools[name] !== undefined
}

function setAction(name: string, value: unknown): void {
  if (value === 'allow' || value === 'ask' || value === 'deny') {
    props.draft.capabilities.tools[name] = value
  }
}

async function reload(): Promise<void> {
  await agents.fetchTools(props.agentId)
}

onMounted(() => {
  if (agents.tools === null) void reload()
})
</script>

<template>
  <section class="editor-section">
    <div class="editor-section__head">
      <h2 class="editor-section__title">工具能力</h2>
      <p class="editor-section__desc">
        工具目录来自运行时发现结果，授权只影响本 Agent。未在此处显式授权的工具一律按默认拒绝处理。
      </p>
    </div>

    <Banner v-if="blocked.length > 0" type="warning" title="受限运行时已移除以下能力">
      <template #description>
        <div class="tag-row">
          <Tag v-for="item in blocked" :key="item" type="light" color="orange">{{ item }}</Tag>
        </div>
      </template>
    </Banner>

    <div class="tool-row" style="grid-template-columns: minmax(0, 1fr) auto">
      <div class="editor-row__main">
        <span class="editor-row__title">子智能体</span>
        <span class="editor-row__desc">
          允许 Agent 派生子智能体会扩大权限面，第一版受限运行时固定禁用，开关不可更改。
        </span>
      </div>
      <div class="editor-row__control">
        <Tag type="light" color="grey">第一版不支持</Tag>
        <Switch :model-value="false" disabled />
      </div>
    </div>

    <div class="toolbar">
      <span class="muted">已授权 {{ authorizedCount }} 个工具（allow / ask）</span>
      <span class="filter-bar__spacer" />
      <Button size="small" theme="borderless" type="tertiary" :loading="agents.toolsLoading" @click="reload">
        <template #icon><IconRefresh /></template>
        刷新工具目录
      </Button>
    </div>

    <div v-if="agents.toolsLoading && tools.length === 0" class="mcp-form">
      <Spin size="middle" tip="加载工具目录" />
    </div>

    <EmptyState
      v-else-if="tools.length === 0"
      title="工具目录为空"
      description="网关未返回可用的工具。请确认运行时已启动、业务工具目录已生成，或重试刷新。"
      action-label="重试"
      compact
      @action="reload"
    />

    <div v-for="group in groups" :key="group.source" class="tools-group">
      <div class="tools-group__head">
        <span class="tools-group__title">{{ group.label }}</span>
        <StatusTag kind="tool-source" :value="group.source" size="small" />
        <span class="tools-group__count">{{ group.items.length }} 个</span>
      </div>

      <div v-for="tool in group.items" :key="tool.name" class="tool-row">
        <div class="tool-row__main">
          <div class="tool-row__title">
            <span>{{ tool.title }}</span>
            <span class="tool-row__name">{{ tool.name }}</span>
            <StatusTag kind="risk" :value="tool.risk" size="small" />
            <Tag v-if="tool.requiresApprovalChannel === true" type="light" color="blue" size="small">
              需要审批通道
            </Tag>
            <Tag v-if="!isExplicit(tool.name)" type="light" color="grey" size="small">未配置</Tag>
          </div>
          <p class="tool-row__desc">{{ tool.description }}</p>
        </div>
        <Select
          :model-value="actionFor(tool.name)"
          :option-list="ACTION_OPTIONS"
          :show-clear="false"
          style="width: 100%"
          @change="(value: unknown) => setAction(tool.name, value)"
        />
      </div>
    </div>

    <div class="editor-note">
      <span class="editor-note__icon"><IconWarning /></span>
      <span>
        选择 ask 的工具会写入策略快照的审批通道。审批仅对单次调用有效，超时或撤销即拒绝，不会变成长期授权。
      </span>
    </div>
  </section>
</template>
