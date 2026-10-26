<script setup lang="ts">
import { Tag } from '@aifuxi/semi-ui-vue'
import { computed, ref, watch } from 'vue'

import type { ChatToolCall } from '@/stores/chat'
import { formatDuration } from '@/utils/format'
import { toneFor } from '@/utils/labels'
import { IconChevronRight, IconTool } from '@/ui/icons'

const props = defineProps<{ call: ChatToolCall }>()

const expanded = ref(props.call.status === 'failed' || props.call.status === 'denied')

watch(
  () => props.call.status,
  (status) => {
    if (status === 'failed' || status === 'denied') expanded.value = true
  },
)

const statusMeta = computed(() => {
  switch (props.call.status) {
    case 'running':
      return { label: '执行中', tone: 'running' as const }
    case 'succeeded':
      return { label: '成功', tone: 'success' as const }
    case 'failed':
      return { label: '失败', tone: 'failed' as const }
    case 'denied':
      return { label: '已拒绝', tone: 'denied' as const }
    default:
      return { label: '未知', tone: 'denied' as const }
  }
})

const riskTone = computed(() => (props.call.risk === undefined ? null : toneFor('risk', props.call.risk)))
const hasDetail = computed(
  () => (props.call.argumentsPreview ?? '').length > 0 || (props.call.error ?? '').length > 0,
)
</script>

<template>
  <div class="tool-card" :class="`tool-card--${statusMeta.tone}`">
    <button
      type="button"
      class="tool-card__head"
      :aria-expanded="expanded"
      :disabled="!hasDetail"
      @click="expanded = !expanded"
    >
      <span class="tool-card__icon" aria-hidden="true"><IconTool /></span>
      <span class="tool-card__name">{{ call.tool }}</span>
      <span class="tool-card__status">
        <span class="dot" aria-hidden="true" />
        {{ statusMeta.label }}
      </span>
      <Tag v-if="riskTone" :color="riskTone.color" type="light" size="small">{{ riskTone.label }}</Tag>
      <span v-if="call.durationMs !== undefined" class="tool-card__duration">{{ formatDuration(call.durationMs) }}</span>
      <span v-if="hasDetail" class="tool-card__chevron" :class="{ 'is-open': expanded }" aria-hidden="true">
        <IconChevronRight />
      </span>
    </button>

    <div v-if="expanded" class="tool-card__body">
      <div v-if="call.argumentsPreview" class="tool-card__block">
        <span class="tool-card__label">参数摘要</span>
        <pre class="tool-card__code">{{ call.argumentsPreview }}</pre>
      </div>
      <div v-if="call.error" class="tool-card__block">
        <span class="tool-card__label">错误</span>
        <p class="tool-card__error">{{ call.error }}</p>
      </div>
    </div>
  </div>
</template>
