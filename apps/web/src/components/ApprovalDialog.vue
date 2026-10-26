<script setup lang="ts">
import { Button, Input, Modal, Tag } from '@aifuxi/semi-ui-vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import type { ApprovalChoice, ApprovalPrompt } from '@/stores/chat'
import { formatCountdown } from '@/utils/format'

const props = withDefaults(
  defineProps<{
    prompt: ApprovalPrompt | null
    submitting?: boolean
  }>(),
  { submitting: false },
)

const emit = defineEmits<{ decide: [choice: ApprovalChoice]; expire: [] }>()

const now = ref(Date.now())
const reason = ref('')
let timer: number | null = null
let expiredFor: string | null = null

const remaining = computed(() =>
  props.prompt === null ? 0 : Math.max(0, props.prompt.expiresAt - now.value),
)

const percent = computed(() => {
  const prompt = props.prompt
  if (prompt === null) return 0
  const total = Math.max(1, prompt.expiresAt - prompt.requestedAt)
  return Math.max(0, Math.min(100, (remaining.value / total) * 100))
})

const urgent = computed(() => remaining.value > 0 && remaining.value <= 15_000)

function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

function startTimer(): void {
  stopTimer()
  timer = window.setInterval(() => {
    now.value = Date.now()
  }, 500)
}

watch(
  () => props.prompt?.approvalId,
  (approvalId) => {
    reason.value = ''
    if (approvalId === undefined) {
      stopTimer()
      return
    }
    expiredFor = null
    now.value = Date.now()
    startTimer()
  },
  { immediate: true },
)

watch(remaining, (value) => {
  const prompt = props.prompt
  if (prompt === null || value > 0) return
  if (expiredFor === prompt.approvalId) return
  expiredFor = prompt.approvalId
  stopTimer()
  emit('expire')
})

onBeforeUnmount(stopTimer)

function decide(choice: ApprovalChoice): void {
  emit('decide', choice)
}

function reject(): void {
  decide('rejected')
}
</script>

<template>
  <Modal
    :visible="prompt !== null"
    :title="'工具调用需要授权'"
    :mask-closable="false"
    :footer="false"
    size="small"
    class="approval-modal"
    @cancel="reject"
  >
    <div v-if="prompt" class="approval-modal__body">
      <div class="approval-modal__head">
        <div class="approval-modal__tool">
          <span class="approval-modal__tool-name">{{ prompt.tool }}</span>
          <Tag type="light" color="amber">需人工审批</Tag>
        </div>
        <div class="approval-modal__timer" :class="{ 'is-urgent': urgent }">
          <span>剩余</span>
          <strong>{{ formatCountdown(remaining) }}</strong>
        </div>
      </div>

      <p class="approval-modal__desc">{{ prompt.description }}</p>

      <div class="approval-modal__progress" role="progressbar" :aria-valuenow="Math.round(percent)">
        <span class="approval-modal__progress-bar" :style="{ width: `${percent}%` }" />
      </div>

      <div v-if="prompt.argumentsPreview.length > 0" class="approval-modal__block">
        <span class="approval-modal__label">参数摘要</span>
        <pre class="approval-modal__code">{{ prompt.argumentsPreview }}</pre>
      </div>

      <div class="approval-modal__block">
        <label class="approval-modal__label" for="approval-reason">拒绝理由（可选，写入审计）</label>
        <Input
          id="approval-reason"
          v-model="reason"
          placeholder="例如：查询范围超出本次任务授权"
          :max-length="400"
        />
      </div>

      <p class="approval-modal__note">
        审批仅对本次调用生效，不会扩展为长期授权。超时或关闭页面会自动拒绝，工具不会执行。
      </p>

      <div class="approval-modal__footer">
        <Button theme="borderless" :disabled="submitting" @click="reject">拒绝</Button>
        <Button
          type="primary"
          theme="solid"
          :loading="submitting"
          :disabled="remaining <= 0"
          @click="decide('allowed-once')"
        >
          允许一次
        </Button>
      </div>
    </div>
  </Modal>
</template>
