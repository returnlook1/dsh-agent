<script setup lang="ts">
import type { ConversationStatus, ConversationSummary } from '@agent-studio/shared'
import { Input } from '@aifuxi/semi-ui-vue'
import { computed, ref } from 'vue'

import StatusBadge from '@/components/StatusBadge.vue'
import {
  countByStatus,
  filterConversations,
  type ConversationStatusFilter,
} from '@/utils/conversation-filter'
import { formatDateTime, formatRelativeTime } from '@/utils/format'

const props = defineProps<{
  items: ConversationSummary[]
  activeId: string | null
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  refresh: []
}>()

const query = ref('')
const status = ref<ConversationStatusFilter>('all')

const statusLabels: Record<ConversationStatus, string> = {
  idle: '空闲',
  running: '运行中',
  failed: '失败',
}

const filters = computed<Array<{ key: ConversationStatusFilter; label: string; count: number }>>(() => {
  const counts = countByStatus(props.items)
  return [
    { key: 'all', label: '全部', count: counts.all },
    { key: 'idle', label: '空闲', count: counts.idle },
    { key: 'running', label: '运行中', count: counts.running },
    { key: 'failed', label: '失败', count: counts.failed },
  ]
})

const visible = computed(() => filterConversations(props.items, query.value, status.value))

const filtering = computed(() => query.value.trim().length > 0 || status.value !== 'all')

function clearFilters(): void {
  query.value = ''
  status.value = 'all'
}
</script>

<template>
  <section class="side-card">
    <div class="rail-filter">
      <Input v-model="query" size="small" placeholder="搜索标题 / ID / 项目" class="rail-filter__search" />
      <div class="rail-filter__chips" role="group" aria-label="按状态筛选">
        <button
          v-for="option in filters.filter((item) => item.key === 'all' || item.count > 0)"
          :key="option.key"
          type="button"
          class="rail-filter__chip"
          :class="{ 'is-active': status === option.key }"
          :disabled="option.count === 0 && option.key !== 'all'"
          @click="status = option.key"
        >
          {{ option.label }}
          <span class="rail-filter__count">{{ option.count }}</span>
        </button>
      </div>
      <div v-if="filtering" class="rail-filter__summary">
        匹配 {{ visible.length }} / {{ items.length }}
        <button type="button" class="link-button" @click="clearFilters">清除</button>
      </div>
    </div>

    <div class="side-card__body">
      <p v-if="error" class="history-error">
        {{ error }}
        <button type="button" class="link-button" @click="emit('refresh')">重试</button>
      </p>
      <div v-if="loading && items.length === 0" class="history-empty">正在加载历史对话…</div>
      <div v-else-if="items.length === 0" class="rail-empty">
        <p class="rail-empty__title">还没有对话</p>
        <p class="rail-empty__hint">新建对话后，这里会按项目列出历史记录、状态与消息数。</p>
      </div>
      <div v-else-if="visible.length === 0" class="rail-empty">
        <p class="rail-empty__title">没有匹配的对话</p>
        <p class="rail-empty__hint">试试别的关键词，或把状态切回「全部」。</p>
      </div>
      <div v-else class="history-list">
        <button
          v-for="entry in visible"
          :key="entry.id"
          type="button"
          class="history-item"
          :class="{ 'is-active': entry.id === activeId }"
          @click="emit('select', entry.id)"
        >
          <span class="history-item__title">{{ entry.title.length > 0 ? entry.title : '未命名对话' }}</span>
          <span class="history-item__meta">
            <StatusBadge
              :tone="entry.status"
              :label="statusLabels[entry.status]"
              :hint="`status: ${entry.status}`"
            />
            <span class="history-item__count">{{ entry.messageCount }} 条</span>
            <span class="history-item__time" :title="formatDateTime(entry.updatedAt)">
              {{ formatRelativeTime(entry.updatedAt) }}
            </span>
          </span>
        </button>
      </div>
    </div>
  </section>
</template>
