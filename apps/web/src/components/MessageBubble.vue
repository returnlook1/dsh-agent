<script setup lang="ts">
import { Spin } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import ToolCallCard from '@/components/ToolCallCard.vue'
import type { ChatMessage } from '@/stores/conversation'
import { formatClock } from '@/utils/format'
import { renderMarkdown } from '@/utils/markdown'

const props = defineProps<{ message: ChatMessage }>()

const isUser = computed(() => props.message.role === 'user')
const showPending = computed(
  () => !isUser.value && props.message.content.length === 0 && props.message.toolCalls.length === 0,
)

/**
 * 渲染 Markdown（安全约束见 utils/markdown.ts：原始 HTML 转义、链接协议白名单）。
 * 用户消息也走同一套渲染，方便贴代码块复现问题。
 */
const rendered = computed(() => renderMarkdown(props.message.content))
</script>

<template>
  <article class="msg" :class="[`msg--${message.role}`, { 'msg--failed': message.failed }]">
    <div class="msg__meta">
      <span class="msg__role">{{ isUser ? '我' : '助手' }}</span>
      <span v-if="message.optimistic" class="msg__state">发送中…</span>
      <span class="msg__time">{{ formatClock(message.createdAt) }}</span>
    </div>
    <div class="msg__body">
      <!-- eslint-disable-next-line vue/no-v-html -- 内容已在 renderMarkdown 里转义/过滤 -->
      <div v-if="message.content.length > 0" class="msg__text md" v-html="rendered" />
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
