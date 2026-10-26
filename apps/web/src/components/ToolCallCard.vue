<script setup lang="ts">
import { Tag } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import type { ChatToolCall } from '@/stores/conversation'
import { formatDuration } from '@/utils/format'
import { formatMapAction, prettyJson, previewResultText } from '@/utils/tool-result'

const props = defineProps<{ call: ChatToolCall }>()

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

const hasResult = computed(() => props.call.result !== undefined)
const resultJson = computed(() => (hasResult.value ? prettyJson(props.call.result) : ''))
const mapSummary = computed(() => (hasResult.value ? formatMapAction(props.call.result) : null))
const textResult = computed(() => {
  const raw = props.call.resultText
  if (raw === undefined || raw.length === 0 || hasResult.value) return null
  return previewResultText(raw)
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

    <p v-if="mapSummary !== null" class="tool-call__map-action">{{ mapSummary }}</p>

    <details v-if="hasResult" class="tool-call__result" open>
      <summary>结构化结果</summary>
      <pre class="tool-call__result-json">{{ resultJson }}</pre>
    </details>

    <details v-else-if="textResult !== null" class="tool-call__result" open>
      <summary>工具结果</summary>
      <pre class="tool-call__result-text">{{ textResult.text }}</pre>
      <p v-if="textResult.truncated" class="tool-call__result-note">
        结果较长，已截断展示（仅显示前 {{ textResult.text.length }} 个字符）。
      </p>
    </details>
  </div>
</template>
