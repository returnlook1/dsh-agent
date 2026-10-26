/** MCP 服务器配置状态。 */
import type { McpServerConfig, McpServerDto } from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { mcpApi, type McpTestResult } from '@/services/agent-api'

/** 只保留契约字段，避免把 createdAt/status 等只读字段回传给网关。 */
export function toMcpConfig(server: McpServerDto): McpServerConfig {
  const config: McpServerConfig = {
    id: server.id,
    name: server.name,
    transport: server.transport,
    args: [...server.args],
    envKeys: [...server.envKeys],
    enabled: server.enabled,
    readOnly: server.readOnly,
  }
  if (server.command !== undefined) config.command = server.command
  if (server.url !== undefined) config.url = server.url
  return config
}

export const useMcpStore = defineStore('mcp', () => {
  const servers = ref<McpServerDto[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref<string | null>(null)
  const saving = ref(false)
  const testingId = ref<string | null>(null)
  const testResults = ref<Record<string, McpTestResult>>({})

  async function fetchList(force = false): Promise<void> {
    if (loading.value) return
    if (loaded.value && !force) return
    loading.value = true
    loadError.value = null
    try {
      const response = await mcpApi.list()
      servers.value = response.items
      loaded.value = true
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : '加载 MCP 服务器失败'
      throw error
    } finally {
      loading.value = false
    }
  }

  async function create(payload: McpServerConfig): Promise<McpServerDto> {
    saving.value = true
    try {
      const created = await mcpApi.create(payload)
      servers.value = [created, ...servers.value.filter((item) => item.id !== created.id)]
      return created
    } finally {
      saving.value = false
    }
  }

  async function update(id: string, payload: McpServerConfig): Promise<McpServerDto> {
    saving.value = true
    try {
      const updated = await mcpApi.update(id, payload)
      servers.value = servers.value.map((item) => (item.id === updated.id ? updated : item))
      return updated
    } finally {
      saving.value = false
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<McpServerDto> {
    const current = servers.value.find((item) => item.id === id)
    if (current === undefined) throw new Error('MCP 服务器不存在')
    const updated = await mcpApi.update(id, { ...toMcpConfig(current), enabled })
    servers.value = servers.value.map((item) => (item.id === updated.id ? updated : item))
    return updated
  }

  async function remove(id: string): Promise<void> {
    await mcpApi.remove(id)
    servers.value = servers.value.filter((item) => item.id !== id)
    testResults.value = Object.fromEntries(
      Object.entries(testResults.value).filter(([key]) => key !== id),
    )
  }

  async function test(id: string): Promise<McpTestResult> {
    testingId.value = id
    try {
      const result = await mcpApi.test(id)
      testResults.value = { ...testResults.value, [id]: result }
      return result
    } finally {
      testingId.value = null
    }
  }

  function reset(): void {
    servers.value = []
    loaded.value = false
    testResults.value = {}
  }

  return {
    servers,
    loading,
    loaded,
    loadError,
    saving,
    testingId,
    testResults,
    fetchList,
    create,
    update,
    setEnabled,
    remove,
    test,
    reset,
  }
})
