<script setup lang="ts">
import { Tag } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

export type StatusTone = 'online' | 'offline' | 'checking' | 'idle' | 'running' | 'failed'

const props = defineProps<{
  tone: StatusTone
  label: string
  hint?: string
}>()

const color = computed<'green' | 'blue' | 'red' | 'grey'>(() => {
  switch (props.tone) {
    case 'online':
      return 'green'
    case 'running':
      return 'blue'
    case 'failed':
      return 'red'
    default:
      // offline / checking / idle 统一置灰。
      return 'grey'
  }
})

const pulse = computed(() => props.tone === 'running' || props.tone === 'checking')
</script>

<template>
  <Tag
    :color="color"
    type="light"
    size="small"
    class="status-badge"
    :class="[`status-badge--${tone}`, { 'status-badge--pulse': pulse }]"
    :title="hint"
  >
    <span class="status-badge__dot" aria-hidden="true" />
    <span class="status-badge__label">{{ label }}</span>
  </Tag>
</template>
