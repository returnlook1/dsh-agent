<script setup lang="ts">
import type { ConversationStatus } from '@agent-studio/shared'
import { Button, SideSheet, Tag, Typography } from '@aifuxi/semi-ui-vue'
import { computed, ref } from 'vue'

import StatusBadge from '@/components/StatusBadge.vue'
import { useConversationStore } from '@/stores/conversation'
import { useUiStore } from '@/stores/ui'
import { copyText } from '@/utils/clipboard'

const conversation = useConversationStore()
const ui = useUiStore()

const sheetVisible = ref(false)

const statusLabels: Record<ConversationStatus, string> = {
  idle: '空闲',
  running: '运行中',
  failed: '失败',
}

const current = computed(() => conversation.current)
const config = computed(() => conversation.current?.config ?? null)
const modelLabel = computed(() =>
  config.value === null ? '' : `${config.value.provider} / ${config.value.model}`,
)

async function copy(label: string, value: string): Promise<void> {
  if (value.length === 0) return
  const ok = await copyText(value)
  if (ok) ui.notifySuccess(`${label} 已复制`)
  else ui.notifyError('复制失败，请手动选择文本复制')
}

async function refresh(): Promise<void> {
  await conversation.reloadConversation()
}
</script>

<template>
  <section class="side-card">
    <header class="side-card__head">
      <div class="side-card__title">当前对话</div>
      <Button
        size="small"
        theme="borderless"
        :disabled="current === null || conversation.streaming"
        @click="refresh"
      >
        刷新
      </Button>
    </header>

    <div class="side-card__body">
      <p v-if="current === null" class="meta-empty">
        <Typography.Text type="tertiary" size="small">尚未创建对话。</Typography.Text>
      </p>
      <template v-else>
        <div class="meta-row">
          <span class="meta-row__k">状态</span>
          <span class="meta-row__v">
            <StatusBadge
              :tone="current.status"
              :label="statusLabels[current.status]"
              :hint="`status: ${current.status}`"
            />
            <span class="meta-muted">{{ current.messageCount }} 条消息</span>
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-row__k">conversationId</span>
          <span class="meta-row__v">
            <code class="meta-code" :title="current.id">{{ current.id }}</code>
            <Button size="small" theme="borderless" @click="copy('conversationId', current.id)">复制</Button>
          </span>
        </div>
        <div class="meta-row">
          <span class="meta-row__k">sessionId</span>
          <span class="meta-row__v">
            <code class="meta-code" :title="current.sessionId">{{ current.sessionId }}</code>
            <Button size="small" theme="borderless" @click="copy('sessionId', current.sessionId)">复制</Button>
          </span>
        </div>
        <div class="meta-actions">
          <Button size="small" theme="borderless" :disabled="config === null" @click="sheetVisible = true">
            配置快照
          </Button>
        </div>
      </template>
    </div>

    <SideSheet
      :visible="sheetVisible"
      title="对话配置快照"
      placement="right"
      :width="440"
      @update:visible="sheetVisible = $event"
      @cancel="sheetVisible = false"
    >
      <div v-if="config !== null" class="snapshot">
        <div class="snapshot__row">
          <span class="meta-row__k">模型</span>
          <span class="meta-row__v">{{ modelLabel }}</span>
        </div>
        <div class="snapshot__row">
          <span class="meta-row__k">Skills</span>
          <span class="meta-row__v">
            <Tag v-for="name in config.skills" :key="name" size="small" type="light" color="blue">{{ name }}</Tag>
            <span v-if="config.skills.length === 0" class="meta-muted">未启用</span>
          </span>
        </div>
        <div class="snapshot__row">
          <span class="meta-row__k">MCP</span>
          <span class="meta-row__v">
            <Tag v-for="name in config.mcpServers" :key="name" size="small" type="light" color="cyan">
              {{ name }}
            </Tag>
            <span v-if="config.mcpServers.length === 0" class="meta-muted">未启用</span>
          </span>
        </div>
        <div class="snapshot__row">
          <span class="meta-row__k">系统提示词</span>
          <span class="meta-row__v">
            <pre v-if="config.systemPrompt.length > 0" class="snapshot__prompt">{{ config.systemPrompt }}</pre>
            <span v-else class="meta-muted">未设置</span>
          </span>
        </div>
        <div class="snapshot__row">
          <span class="meta-row__k">configKey</span>
          <span class="meta-row__v"><code class="meta-code">{{ config.configKey || '—' }}</code></span>
        </div>
        <div class="snapshot__row">
          <span class="meta-row__k">继承项目配置</span>
          <span class="meta-row__v">
            <Tag size="small" type="light" :color="config.inheritedFromProject ? 'green' : 'grey'">
              {{ config.inheritedFromProject ? '是' : '否' }}
            </Tag>
          </span>
        </div>
      </div>
    </SideSheet>
  </section>
</template>
