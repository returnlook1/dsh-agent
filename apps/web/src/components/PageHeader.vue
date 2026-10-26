<script setup lang="ts">
import { Typography } from '@aifuxi/semi-ui-vue'

import { IconBack } from '@/ui/icons'

withDefaults(
  defineProps<{
    title: string
    description?: string
    backTo?: string
    backLabel?: string
  }>(),
  { description: '', backTo: '', backLabel: '返回' },
)
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <RouterLink v-if="backTo" :to="backTo" class="page-header__back">
        <IconBack />
        <span>{{ backLabel }}</span>
      </RouterLink>
      <Typography.Title :heading="4" class="page-header__title">{{ title }}</Typography.Title>
      <Typography.Text v-if="description" type="tertiary" size="small" class="page-header__desc">
        {{ description }}
      </Typography.Text>
      <slot name="meta" />
    </div>
    <div class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>
