<script setup lang="ts">
import {
  Banner,
  Button,
  Input,
  Modal,
  Popconfirm,
  Spin,
  TextArea,
  Typography,
} from '@aifuxi/semi-ui-vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'

import MessageBubble from '@/components/MessageBubble.vue'
import { useConfigStore } from '@/stores/config'
import { useConversationStore } from '@/stores/conversation'
import { useUiStore } from '@/stores/ui'

const conversation = useConversationStore()
const config = useConfigStore()

const emit = defineEmits<{
  create: []
}>()
const ui = useUiStore()
const router = useRouter()

const draft = ref('')
const scroller = ref<HTMLElement | null>(null)

const renameVisible = ref(false)
const renameDraft = ref('')
const renameError = ref<string | null>(null)
const actionNotice = ref<{
  type: 'warning' | 'danger'
  title: string
  description: string
} | null>(null)

const current = computed(() => conversation.current)
const isRunning = computed(
  () => current.value !== null && (conversation.streaming || current.value.status === 'running'),
)
const canSubmit = computed(
  () => current.value !== null && !conversation.streaming && draft.value.trim().length > 0,
)
const title = computed(() => {
  if (current.value === null) return '对话测试'
  const raw = current.value.title.trim()
  return raw.length > 0 ? raw : '新对话'
})
const subtitle = computed(() => {
  if (current.value === null) return '选好能力后新建对话，再发送第一条消息'
  return `项目 ${current.value.projectId} · ${current.value.messageCount} 条消息`
})
const modelLabel = computed(() => {
  const config = current.value?.config
  return config === undefined ? '' : `${config.provider} / ${config.model}`
})

async function scrollToBottom(): Promise<void> {
  await nextTick()
  const element = scroller.value
  if (element !== null) element.scrollTop = element.scrollHeight
}

watch(
  () => conversation.activityTick,
  () => {
    void scrollToBottom()
  },
)
watch(
  () => conversation.messagesLoading,
  (loading) => {
    if (!loading) void scrollToBottom()
  },
)
watch(
  () => conversation.current?.id,
  () => {
    void scrollToBottom()
  },
)

onMounted(() => {
  void scrollToBottom()
})

async function submit(): Promise<void> {
  if (!canSubmit.value) return
  const content = draft.value
  draft.value = ''
  const result = await conversation.send(content)
  if (!result.ok && result.aborted !== true) {
    // 失败时把草稿还原，避免用户重新输入。
    draft.value = content
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void submit()
}

function refresh(): void {
  void conversation.reloadConversation()
  void conversation.loadHistory(conversation.current?.projectId)
}

function clearError(): void {
  conversation.clearError()
}

/** 停止本轮；409 RUNTIME_BUSY 只展示后端说明，不自动重试。 */
async function stopTurn(): Promise<void> {
  actionNotice.value = null
  const result = await conversation.stop()
  if (result.ok) {
    ui.notifySuccess('已停止')
    if (result.note !== undefined && result.note.length > 0) ui.notifyInfo(result.note)
    return
  }
  const message = result.message ?? '停止失败'
  const busy = result.conflict === true
  actionNotice.value = {
    type: busy ? 'warning' : 'danger',
    title: busy ? '无法停止（RUNTIME_BUSY）' : '停止失败',
    description: message,
  }
  ui.notifyError(message)
}

function openRename(): void {
  if (current.value === null) return
  renameDraft.value = current.value.title
  renameError.value = null
  renameVisible.value = true
}

function closeRename(): void {
  if (conversation.renaming) return
  renameVisible.value = false
  renameError.value = null
}

async function submitRename(): Promise<void> {
  if (conversation.renaming) return
  const title = renameDraft.value.trim()
  if (title.length === 0) {
    renameError.value = '标题不能为空'
    return
  }
  if (title.length > 200) {
    renameError.value = '标题不能超过 200 个字符'
    return
  }
  const result = await conversation.rename(title)
  if (result.ok) {
    renameVisible.value = false
    renameError.value = null
    ui.notifySuccess('已重命名')
    return
  }
  renameError.value = result.message ?? '重命名失败'
  ui.notifyError(renameError.value)
}

/** 删除当前对话；成功后清空会话并回到「新对话」态。 */
async function removeCurrent(): Promise<void> {
  actionNotice.value = null
  const result = await conversation.deleteCurrent()
  if (result.ok) {
    ui.notifySuccess('对话已删除')
    const projectId = result.projectId
    try {
      await router.push({ name: 'playground' })
    } catch {
      // 路由失败不影响已删除的本地会话；历史列表仍会刷新。
    }
    void conversation.loadHistory(projectId)
    return
  }
  const message = result.message ?? '删除失败'
  const running = result.conflict === true
  actionNotice.value = {
    type: running ? 'warning' : 'danger',
    title: running ? '无法删除（对话正在运行）' : '删除对话失败',
    description: message,
  }
  ui.notifyError(message)
}
</script>

<template>
  <section class="chat-panel">
    <header class="chat-panel__head">
      <div class="chat-panel__identity">
        <p class="panel__eyebrow">session</p>
        <div class="chat-panel__titleline">
          <Typography.Title :heading="5" class="chat-panel__title">{{ title }}</Typography.Title>
          <span v-if="conversation.streaming" class="chat-panel__running">
            <Spin size="small" />
            <span>运行中</span>
          </span>
        </div>
        <p class="chat-panel__sub">
          <span>{{ subtitle }}</span>
          <span v-if="modelLabel.length > 0" class="chat-panel__route">{{ modelLabel }}</span>
        </p>
      </div>
      <div class="chat-panel__actions">
        <Button
          v-if="isRunning"
          size="small"
          type="danger"
          theme="borderless"
          :loading="conversation.stopping"
          :disabled="conversation.stopping"
          @click="stopTurn"
        >
          停止
        </Button>
        <Button
          v-if="current !== null"
          size="small"
          theme="borderless"
          :disabled="conversation.renaming"
          @click="openRename"
        >
          重命名
        </Button>
        <Popconfirm
          v-if="current !== null"
          title="删除当前对话？"
          content="删除后不可恢复，历史消息将一并移除。"
          ok-text="删除"
          cancel-text="取消"
          ok-type="danger"
          :disabled="conversation.deleting"
          @confirm="removeCurrent"
        >
          <Button
            size="small"
            type="danger"
            theme="borderless"
            :loading="conversation.deleting"
            :disabled="conversation.deleting"
          >
            删除
          </Button>
        </Popconfirm>
        <Button
          v-if="current !== null"
          size="small"
          theme="borderless"
          :disabled="conversation.streaming"
          @click="refresh"
        >
          刷新
        </Button>
      </div>
    </header>

    <div ref="scroller" class="chat-scroll">
      <div class="chat-column">
        <Banner
          v-if="actionNotice !== null"
          :type="actionNotice.type"
          :title="actionNotice.title"
          @close="actionNotice = null"
        >
          <template #description>{{ actionNotice.description }}</template>
        </Banner>

        <Banner
          v-if="conversation.error"
          type="danger"
          :title="conversation.errorCode ? `本轮未完成 · ${conversation.errorCode}` : '本轮未完成'"
          @close="clearError"
        >
          <template #description>{{ conversation.error }}</template>
        </Banner>

        <Banner
          v-if="conversation.truncated"
          type="warning"
          title="历史记录可能不完整"
          description="服务端在运行时崩溃等情况下可能截断消息记录，已展示的部分仍可回放。"
        />

        <div v-if="conversation.messagesLoading" class="chat-loading">
          <Spin size="middle" />
          <span>正在加载对话历史…</span>
        </div>

        <template v-else-if="conversation.messages.length > 0">
          <MessageBubble
            v-for="message in conversation.messages"
            :key="message.id"
            :message="message"
          />
          <div v-if="conversation.streaming" class="chat-running">
            <Spin size="small" />
            <span>助手正在处理本轮，事件到达后即时更新…</span>
          </div>
        </template>

        <div v-else-if="current === null" class="pad-empty">
          <p class="pad-empty__eyebrow">ready to launch</p>
          <h2 class="pad-empty__title">开始一次受限对话</h2>
          <p class="pad-empty__desc">
            Agent Service 只负责项目、Skill、MCP 与会话；模型与凭据由 DSH 统一提供。
            在右栏确认能力后新建对话，发送第一条消息即可观察工具调用与结果。
          </p>
          <div class="pad-empty__stats">
            <div class="stat">
              <p class="stat__k">project</p>
              <p class="stat__v">{{ config.projectId.trim() || '未选择' }}</p>
            </div>
            <div class="stat">
              <p class="stat__k">capabilities</p>
              <p class="stat__v stat__v--accent">
                {{ config.selectedSkills.length }} skills · {{ config.selectedMcpServers.length }} mcp
              </p>
            </div>
            <div class="stat">
              <p class="stat__k">route</p>
              <p class="stat__v" :title="`${config.provider} / ${config.model}`">{{ config.provider || '—' }} / {{ config.model || '—' }}</p>
            </div>
          </div>
          <div class="pad-empty__actions">
            <Button type="primary" theme="solid" :disabled="!config.hasUsableModel" @click="emit('create')">
              新建对话
            </Button>
            <span class="pad-empty__hint">与左栏「新建对话」等价；创建后这里显示消息流。</span>
          </div>
        </div>

        <div v-else class="chat-welcome">
          <h2>对话已创建</h2>
          <p>
            发送第一条消息开始测试。助手会在同一轮里按需调用你启用的 Skills 与 MCP
            服务器；工具调用会以卡片形式出现在助手消息下方。
          </p>
        </div>
      </div>
    </div>

    <footer class="chat-composer">
      <div class="chat-composer__inner">
        <TextArea
          v-model="draft"
          :rows="3"
          resize="none"
          :max-length="100000"
          :disabled="current === null || conversation.streaming"
          :placeholder="
            current === null
              ? '先新建一个对话'
              : conversation.streaming
                ? '本轮运行中，结束后可继续输入'
                : '写下你的问题，或描述要分析的数据…'
          "
          @keydown="onKeydown"
        />
        <div class="chat-composer__actions">
          <span class="chat-composer__hint">
            <template v-if="current === null">尚未选中对话</template>
            <template v-else-if="conversation.streaming">本轮运行中，发送按钮已禁用</template>
            <template v-else>Enter 发送 · Shift + Enter 换行</template>
          </span>
          <Button
            type="primary"
            theme="solid"
            :loading="conversation.streaming"
            :disabled="!canSubmit"
            @click="submit"
          >
            发送
          </Button>
        </div>
      </div>
    </footer>
  </section>

  <Modal
    :visible="renameVisible"
    title="重命名对话"
    ok-text="保存"
    cancel-text="取消"
    :confirm-loading="conversation.renaming"
    @ok="submitRename"
    @cancel="closeRename"
  >
    <div class="rename-form">
      <Banner v-if="renameError" type="danger" title="重命名失败">
        <template #description>{{ renameError }}</template>
      </Banner>
      <Input
        v-model="renameDraft"
        :max-length="200"
        placeholder="输入 1–200 个字符的标题"
        :disabled="conversation.renaming"
        @enter-press="submitRename"
      />
      <p class="field__hint">保存后立即写入服务端（PATCH /conversations/:id）。</p>
    </div>
  </Modal>
</template>
