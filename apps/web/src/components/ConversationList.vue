<script setup lang="ts">
import type { ConversationStatus, ConversationSummary } from '@agent-studio/shared'
import { Button, Tag, Typography } from '@aifuxi/semi-ui-vue'

import StatusBadge from '@/components/StatusBadge.vue'
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

const statusLabels: Record<ConversationStatus, string> = {
  idle: '空闲',
  running: '运行中',
  failed: '失败',
}
</script>

<template>
  <section class="side-card">
    <header class="side-card__head">
      <div class="side-card__title">
        历史对话
        <Tag v-if="items.length > 0" size="small" type="light" color="grey">{{ items.length }}</Tag>
      </div>
      <Button size="small" theme="borderless" :loading="loading" @click="emit('refresh')">刷新</Button>
    </header>

    <div class="side-card__body">
      <p v-if="error" class="history-error">
        {{ error }}
        <button type="button" class="link-button" @click="emit('refresh')">重试</button>
      </p>

      <div v-if="loading && items.length === 0" class="history-empty">
        <Typography.Text type="tertiary" size="small">正在加载历史对话…</Typography.Text>
      </div>
      <p v-else-if="items.length === 0" class="history-empty">
        <Typography.Text type="tertiary" size="small">该项目还没有对话记录。</Typography.Text>
      </p>
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
            <span class="history-item__time" :title="formatDateTime(item.updatedAt)">
              {{ formatRelativeTime(item.updatedAt) }}
            </span>
            <span class="history-item__count">{{ item.messageCount }} 条</span>
          </span>
        </button>
      </div>
    </div>
  </section>
</template>
