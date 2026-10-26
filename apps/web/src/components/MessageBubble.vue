<script setup lang="ts">
import { Spin } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import ToolCallCard from '@/components/ToolCallCard.vue'
import type { ChatMessage } from '@/stores/conversation'
import { formatClock } from '@/utils/format'

const props = defineProps<{ message: ChatMessage }>()

const isUser = computed(() => props.message.role === 'user')
const showPending = computed(
  () => !isUser.value && props.message.content.length === 0 && props.message.toolCalls.length === 0,
)
</script>

<template>
  <article class="msg" :class="[`msg--${message.role}`, { 'msg--failed': message.failed }]">
    <div class="msg__meta">
      <span class="msg__role">{{ isUser ? '我' : '助手' }}</span>
      <span v-if="message.optimistic" class="msg__state">发送中…</span>
      <span class="msg__time">{{ formatClock(message.createdAt) }}</span>
    </div>
    <div class="msg__body">
      <p v-if="message.content.length > 0" class="msg__text">{{ message.content }}</p>
      <div v-else-if="showPending" class="msg__pending">
        <Spin size="small" />
        <span>正在处理…</span>
      </div>
      <div v-if="message.toolCalls.length > 0" class="msg__tools">
        <ToolCallCard v-for="call in message.toolCalls" :key="call.callId" :call="call" />
      </div>
    </div>
  </article>
</template>
