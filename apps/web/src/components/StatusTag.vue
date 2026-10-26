<script setup lang="ts">
import { Tag } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import { toneFor, type StatusKind } from '@/utils/labels'

const props = defineProps<{
  kind: StatusKind
  value: string | undefined
  size?: 'small' | 'default' | 'large'
}>()

const tone = computed(() => toneFor(props.kind, props.value))
</script>

<template>
  <Tag
    :color="tone.color"
    :type="tone.emphasis === true ? 'solid' : 'light'"
    :size="props.size ?? 'default'"
    class="status-tag"
  >
    {{ tone.label }}
  </Tag>
</template>
