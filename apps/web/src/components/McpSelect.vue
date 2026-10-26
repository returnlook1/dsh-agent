<script setup lang="ts">
import type { McpProbeResponse, McpServerSummaryDto } from '@agent-studio/shared'
import type { SelectModelValue, SelectOptionProps } from '@aifuxi/semi-ui-vue'
import { Banner, Button, SideSheet, Spin, Tag } from '@aifuxi/semi-ui-vue'
import { computed, ref } from 'vue'

import { useConfigStore, type McpProbeState } from '@/stores/config'
import { useUiStore } from '@/stores/ui'
import { formatDuration } from '@/utils/format'
import { prettyJson } from '@/utils/tool-result'

const props = defineProps<{
  modelValue: string[]
  servers: McpServerSummaryDto[]
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const config = useConfigStore()
const ui = useUiStore()

const sheetVisible = ref(false)
const sheetServer = ref<McpServerSummaryDto | null>(null)

const options = computed<SelectOptionProps[]>(() =>
  [...props.servers]
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name))
    .map((server) => ({
      value: server.id,
      label: `${server.name} · ${server.transport}${server.enabled ? '' : '（已停用）'}`,
      disabled: !server.enabled,
    })),
)

const sortedServers = computed(() =>
  [...props.servers].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  ),
)

const selectedNames = computed(() =>
  props.servers
    .filter((server) => props.modelValue.includes(server.id))
    .map((server) => `${server.name} · ${server.transport}`),
)

const sheetState = computed<McpProbeState | null>(() => {
  const server = sheetServer.value
  if (server === null) return null
  return config.mcpProbeStates[server.id] ?? null
})

const sheetProbe = computed<McpProbeResponse | null>(() => sheetState.value?.result ?? null)

const sheetServerName = computed(() => {
  const probe = sheetProbe.value
  if (probe?.serverName !== undefined && probe.serverName.length > 0) return probe.serverName
  return sheetServer.value?.name ?? ''
})

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

function sourceLabel(server: McpServerSummaryDto): string {
  return server.source === 'dsh-profile' ? 'DSH Profile' : '配置文件'
}

function sourceColor(server: McpServerSummaryDto): 'blue' | 'purple' {
  return server.source === 'dsh-profile' ? 'purple' : 'blue'
}

function stateOf(serverId: string): McpProbeState | undefined {
  return config.mcpProbeStates[serverId]
}

function isTesting(serverId: string): boolean {
  return stateOf(serverId)?.phase === 'testing'
}

function toolCount(serverId: string): number {
  return stateOf(serverId)?.result?.tools.length ?? 0
}

function clearSheetError(): void {
  if (sheetServer.value !== null) config.clearMcpProbeState(sheetServer.value.id)
}

/** 行内测试：同一服务器的并发请求由 config store 去重，这里只负责反馈。 */
async function runTest(server: McpServerSummaryDto): Promise<void> {
  if (isTesting(server.id)) return
  const result = await config.probeMcpServer(server.id, 'test')
  if (result === null) {
    ui.notifyError(stateOf(server.id)?.error ?? 'MCP 测试失败')
    return
  }
  if (!result.ok) {
    ui.notifyError(stateOf(server.id)?.error ?? 'MCP 测试失败')
    return
  }
  ui.notifySuccess(`MCP 测试成功：${result.tools.length} 个工具，耗时 ${formatDuration(result.durationMs)}`)
}

/** 复用测试结果打开工具预览；没有缓存时（理论上不会）再探测一次。 */
function openTools(server: McpServerSummaryDto): void {
  sheetServer.value = server
  sheetVisible.value = true
  if (stateOf(server.id)?.result === null || stateOf(server.id) === undefined) {
    void reloadTools()
  }
}

async function reloadTools(): Promise<void> {
  const server = sheetServer.value
  if (server === null || isTesting(server.id)) return
  const result = await config.probeMcpServer(server.id, 'tools')
  if (result === null || !result.ok) {
    ui.notifyError(stateOf(server.id)?.error ?? '获取 MCP 工具清单失败')
  }
}

function closeSheet(): void {
  sheetVisible.value = false
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

    <div v-else-if="servers.length > 0" class="mcp-server-list">
      <div v-for="server in sortedServers" :key="server.id" class="mcp-server">
        <div class="mcp-server__head">
          <span class="mcp-server__name" :title="server.name">{{ server.name }}</span>
          <Tag size="small" type="light" :color="sourceColor(server)">{{ sourceLabel(server) }}</Tag>
          <Tag size="small" type="light" color="grey">{{ server.transport }}</Tag>
          <Tag v-if="!server.enabled" size="small" type="light" color="orange">已停用</Tag>
          <span class="mcp-server__spacer" />
          <Button
            size="small"
            theme="borderless"
            :loading="isTesting(server.id)"
            :disabled="isTesting(server.id)"
            @click="runTest(server)"
          >
            测试
          </Button>
        </div>

        <p v-if="server.description" class="mcp-server__desc">{{ server.description }}</p>

        <div v-if="stateOf(server.id)" class="mcp-server__status">
          <template v-if="stateOf(server.id)?.phase === 'testing'">
            <Spin size="small" />
            <span>测试中…（最长约 25 秒）</span>
          </template>
          <template v-else-if="stateOf(server.id)?.phase === 'success' && stateOf(server.id)?.result?.ok">
            <span class="mcp-server__ok">成功</span>
            <span>{{ formatDuration(stateOf(server.id)?.result?.durationMs ?? 0) }}</span>
            <span>{{ toolCount(server.id) }} 个工具</span>
            <Button
              size="small"
              theme="borderless"
              :disabled="isTesting(server.id)"
              @click="openTools(server)"
            >
              查看工具
            </Button>
          </template>
          <template v-else>
            <span class="mcp-server__fail">失败</span>
            <span class="mcp-server__error-text" :title="stateOf(server.id)?.error ?? ''">
              {{ stateOf(server.id)?.error ?? '未知错误' }}
            </span>
            <details v-if="stateOf(server.id)?.error" class="mcp-server__error-detail">
              <summary>错误详情</summary>
              <pre>{{ stateOf(server.id)?.error }}</pre>
            </details>
          </template>
        </div>
      </div>
    </div>

    <p v-if="selectedNames.length > 0" class="field__hint">
      已启用：{{ selectedNames.join('、') }}
    </p>
  </div>

  <SideSheet
    :visible="sheetVisible"
    title="MCP 工具预览"
    placement="right"
    :width="540"
    @update:visible="sheetVisible = $event"
    @cancel="closeSheet"
  >
    <div v-if="sheetServer !== null" class="mcp-tools">
      <Banner
        v-if="sheetState?.phase === 'error'"
        type="danger"
        title="工具清单获取失败"
        @close="clearSheetError"
      >
        <template #description>{{ sheetState.error }}</template>
      </Banner>

      <div class="mcp-tools__meta">
        <div class="mcp-tools__meta-row">
          <span class="meta-row__k">服务器</span>
          <span class="meta-row__v">{{ sheetServerName }}</span>
        </div>
        <div class="mcp-tools__meta-row">
          <span class="meta-row__k">协议版本</span>
          <span class="meta-row__v">{{ sheetProbe?.protocolVersion ?? '未返回' }}</span>
        </div>
        <div class="mcp-tools__meta-row">
          <span class="meta-row__k">Transport</span>
          <span class="meta-row__v">{{ sheetProbe?.transport ?? sheetServer.transport }}</span>
        </div>
        <div class="mcp-tools__meta-row">
          <span class="meta-row__k">耗时</span>
          <span class="meta-row__v">
            {{ sheetProbe === null ? '—' : formatDuration(sheetProbe.durationMs) }}
          </span>
        </div>
      </div>

      <div v-if="sheetState?.phase === 'testing'" class="mcp-tools__loading">
        <Spin size="small" />
        <span>正在重新探测并读取 tools/list…</span>
      </div>

      <template v-else-if="sheetProbe?.ok">
        <div class="mcp-tools__head">
          <span class="field__label">工具</span>
          <Tag size="small" type="light" color="cyan">{{ sheetProbe.tools.length }}</Tag>
        </div>
        <p v-if="sheetProbe.tools.length === 0" class="field__hint">
          探测成功，但该服务器没有返回任何工具。
        </p>
        <div v-else class="mcp-tool-list">
          <div v-for="tool in sheetProbe.tools" :key="tool.name" class="mcp-tool">
            <div class="mcp-tool__name">{{ tool.name }}</div>
            <p class="mcp-tool__desc">{{ tool.description ?? '无描述' }}</p>
            <details class="mcp-tool__schema">
              <summary>inputSchema</summary>
              <pre v-if="tool.inputSchema !== undefined">{{ prettyJson(tool.inputSchema) }}</pre>
              <p v-else class="field__hint">未提供 inputSchema。</p>
            </details>
          </div>
        </div>
      </template>

      <template v-else-if="sheetProbe !== null">
        <p class="mcp-tools__error">
          {{ sheetProbe.error ?? '探测失败，服务端未返回原因。' }}
        </p>
      </template>
    </div>

    <template #footer>
      <Button
        theme="borderless"
        :loading="sheetState?.phase === 'testing'"
        :disabled="sheetState?.phase === 'testing' || sheetServer === null"
        @click="reloadTools"
      >
        重新探测（GET /tools）
      </Button>
    </template>
  </SideSheet>
</template>
