<script setup lang="ts">
import type { AgentSummary } from '@agent-studio/shared'
import { Select } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

const props = withDefaults(
  defineProps<{
    agents: AgentSummary[]
    modelValue: string
    loading?: boolean
    disabled?: boolean
  }>(),
  { loading: false, disabled: false },
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const optionList = computed(() =>
  props.agents.map((agent) => ({
    value: agent.id,
    label: agent.name,
    disabled: agent.status !== 'published',
  })),
)

function handleChange(value: unknown): void {
  if (typeof value === 'string') emit('update:modelValue', value)
}
</script>

<template>
  <div class="agent-selector">
    <label class="agent-selector__label" for="chat-agent-select">当前智能体</label>
    <Select
      id="chat-agent-select"
      :model-value="modelValue.length > 0 ? modelValue : undefined"
      :option-list="optionList"
      :loading="loading"
      :disabled="disabled"
      :show-clear="false"
      placeholder="选择智能体"
      class="agent-selector__select"
      @change="handleChange"
    />
    <p v-if="agents.length > 0" class="agent-selector__hint">仅列出已发布版本，切换智能体会重置当前对话视图。</p>
    <p v-else class="agent-selector__hint">暂无已发布智能体。</p>
  </div>
</template>
