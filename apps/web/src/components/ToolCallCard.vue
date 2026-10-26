<script setup lang="ts">
import type { ToolCallRecord } from '@agent-studio/shared'
import { Tag } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import { formatDuration } from '@/utils/format'

const props = defineProps<{ call: ToolCallRecord }>()

const meta = computed<{ label: string; color: 'blue' | 'green' | 'red' }>(() => {
  switch (props.call.status) {
    case 'running':
      return { label: '运行中', color: 'blue' }
    case 'succeeded':
      return { label: '成功', color: 'green' }
    case 'failed':
      return { label: '失败', color: 'red' }
    default:
      return { label: props.call.status, color: 'red' }
  }
})
</script>

<template>
  <div class="tool-call" :class="`tool-call--${call.status}`">
    <div class="tool-call__head">
      <span class="tool-call__icon" aria-hidden="true">⚙</span>
      <span class="tool-call__name">{{ call.tool }}</span>
      <Tag size="small" type="light" :color="meta.color">{{ meta.label }}</Tag>
      <span v-if="call.durationMs !== undefined" class="tool-call__duration">
        {{ formatDuration(call.durationMs) }}
      </span>
    </div>
    <pre v-if="call.argumentsPreview" class="tool-call__args" :title="call.argumentsPreview">{{ call.argumentsPreview }}</pre>
    <p v-if="call.error" class="tool-call__error">{{ call.error }}</p>
  </div>
</template>
