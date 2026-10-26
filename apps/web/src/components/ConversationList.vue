<script setup lang="ts">
import type { ConversationStatus, ConversationSummary } from '@agent-studio/shared'
import { Typography } from '@aifuxi/semi-ui-vue'

import StatusBadge from '@/components/StatusBadge.vue'
import { formatDateTime, formatRelativeTime } from '@/utils/format'

defineProps<{
  items: ConversationSummary[]
  activeId: string | null
  loading: boolean
  error: string | null
}>()

const emit = defineEmits<{
  select: [id: string]
  refresh: []
}>()

const statusLabels: Record<ConversationStatus, string> = {
  idle: '空闲',
  running: '运行中',
  failed: '失败',
}
</script>

<template>
  <section class="side-card">
    <div class="side-card__body">
      <p v-if="error" class="history-error">
        {{ error }}
        <button type="button" class="link-button" @click="emit('refresh')">重试</button>
      </p>
      <div v-if="loading && items.length === 0" class="history-empty">
        <Typography.Text type="tertiary" size="small">正在加载历史对话…</Typography.Text>
      </div>
      <div v-else-if="items.length === 0" class="rail-empty">
        <p class="rail-empty__title">还没有对话</p>
        <p class="rail-empty__hint">新建对话后，这里会按项目列出历史记录、状态与消息数。</p>
      </div>
      <div v-else class="history-list">
        <button
          v-for="item in items"
          :key="item.id"
          type="button"
          class="history-item"
          :class="{ 'is-active': item.id === activeId }"
          @click="emit('select', item.id)"
        >
          <span class="history-item__title">{{ item.title.length > 0 ? item.title : '未命名对话' }}</span>
          <span class="history-item__meta">
            <StatusBadge :tone="item.status" :label="statusLabels[item.status]" :hint="`status: ${item.status}`" />
            <span class="history-item__count">{{ item.messageCount }} 条</span>
            <span class="history-item__time" :title="formatDateTime(item.updatedAt)">
              {{ formatRelativeTime(item.updatedAt) }}
            </span>
          </span>
        </button>
      </div>
    </div>
  </section>
</template>
