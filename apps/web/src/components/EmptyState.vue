<script setup lang="ts">
import { Button, Empty } from '@aifuxi/semi-ui-vue'

withDefaults(
  defineProps<{
    title: string
    description?: string
    actionLabel?: string
    compact?: boolean
  }>(),
  { description: '', actionLabel: '', compact: false },
)

defineEmits<{ action: [] }>()
</script>

<template>
  <div class="empty-state" :class="{ 'empty-state--compact': compact }">
    <Empty :title="title" :description="description" />
    <Button v-if="actionLabel" type="primary" theme="light" @click="$emit('action')">
      {{ actionLabel }}
    </Button>
  </div>
</template>
