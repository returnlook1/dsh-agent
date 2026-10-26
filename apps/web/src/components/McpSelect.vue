<script setup lang="ts">
import type { McpServerSummaryDto } from '@agent-studio/shared'
import type { SelectModelValue, SelectOptionProps } from '@aifuxi/semi-ui-vue'
import { Select } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

const props = defineProps<{
  modelValue: string[]
  servers: McpServerSummaryDto[]
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const options = computed<SelectOptionProps[]>(() =>
  [...props.servers]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
    .map((server) => ({
      value: server.id,
      label: `${server.name} · ${server.transport}${server.enabled ? '' : '（已停用）'}`,
      disabled: !server.enabled,
    })),
)

const selectedNames = computed(() =>
  props.servers
    .filter((server) => props.modelValue.includes(server.id))
    .map((server) => `${server.name} · ${server.transport}`),
)

function onChange(value: SelectModelValue): void {
  emit('update:modelValue', toIdList(value))
}

function toIdList(value: SelectModelValue): string[] {
  if (value === undefined) return []
  const list = Array.isArray(value) ? value : [value]
  const out: string[] = []
  for (const item of list) {
    if (typeof item === 'string') out.push(item)
    else if (typeof item === 'number') out.push(String(item))
  }
  return out
}
</script>

<template>
  <div class="mcp-select">
    <Select
      multiple
      filter
      show-clear
      class="mcp-select__control"
      :model-value="modelValue"
      :option-list="options"
      :loading="loading === true"
      :disabled="disabled === true || options.length === 0"
      placeholder="选择 MCP 服务器"
      @change="onChange"
    />
    <p v-if="!loading && servers.length === 0" class="field__hint">
      没有可用 MCP 服务器（服务端未配置 config/mcp-servers.json，或清单加载失败）。
    </p>
    <p v-else-if="selectedNames.length > 0" class="field__hint">
      已启用：{{ selectedNames.join('、') }}
    </p>
  </div>
</template>
