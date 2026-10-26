/** Agent 列表与详情状态。写操作都向调用方抛错，由页面决定如何提示。 */
import type {
  AgentDetail,
  AgentSummary,
  AgentToolsResponse,
  AgentVersionDto,
  CreateAgentRequest,
  UpdateAgentRequest,
} from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { agentApi } from '@/services/agent-api'

export const useAgentsStore = defineStore('agents', () => {
  const items = ref<AgentSummary[]>([])
  const listLoading = ref(false)
  const listLoaded = ref(false)
  const listError = ref<string | null>(null)

  const detail = ref<AgentDetail | null>(null)
  const detailLoading = ref(false)
  const detailError = ref<string | null>(null)

  const tools = ref<AgentToolsResponse | null>(null)
  const toolsLoading = ref(false)

  const saving = ref(false)
  const publishing = ref(false)

  const stats = computed(() => {
    let published = 0
    let draft = 0
    let disabled = 0
    for (const item of items.value) {
      if (item.status === 'published') published += 1
      else if (item.status === 'draft') draft += 1
      else disabled += 1
    }
    return { total: items.value.length, published, draft, disabled }
  })

  const publishedAgents = computed(() => items.value.filter((item) => item.status === 'published'))

  function replaceSummary(next: AgentSummary): void {
    const index = items.value.findIndex((item) => item.id === next.id)
    if (index >= 0) items.value.splice(index, 1, next)
    else items.value.push(next)
  }

  async function fetchList(force = false): Promise<void> {
    if (listLoading.value) return
    if (listLoaded.value && !force) return
    listLoading.value = true
    listError.value = null
    try {
      const response = await agentApi.list()
      items.value = response.items
      listLoaded.value = true
    } catch (error) {
      listError.value = error instanceof Error ? error.message : '加载 Agent 列表失败'
      throw error
    } finally {
      listLoading.value = false
    }
  }

  async function fetchDetail(id: string): Promise<AgentDetail> {
    detailLoading.value = true
    detailError.value = null
    try {
      const response = await agentApi.get(id)
      detail.value = response
      replaceSummary(response)
      return response
    } catch (error) {
      detailError.value = error instanceof Error ? error.message : '加载 Agent 详情失败'
      throw error
    } finally {
      detailLoading.value = false
    }
  }

  async function fetchTools(id: string): Promise<AgentToolsResponse | null> {
    toolsLoading.value = true
    try {
      const response = await agentApi.tools(id)
      tools.value = response
      return response
    } catch {
      // 工具目录不可用不阻塞编辑：页面展示空状态与重试入口。
      tools.value = null
      return null
    } finally {
      toolsLoading.value = false
    }
  }

  async function createAgent(payload: CreateAgentRequest): Promise<AgentDetail> {
    saving.value = true
    try {
      const created = await agentApi.create(payload)
      replaceSummary(created)
      return created
    } finally {
      saving.value = false
    }
  }

  async function saveAgent(id: string, payload: UpdateAgentRequest): Promise<AgentDetail> {
    saving.value = true
    try {
      const updated = await agentApi.update(id, payload)
      detail.value = updated
      replaceSummary(updated)
      return updated
    } finally {
      saving.value = false
    }
  }

  async function publishAgent(id: string): Promise<AgentVersionDto> {
    publishing.value = true
    try {
      const version = await agentApi.publish(id)
      const current = detail.value
      if (current !== null) {
        const exists = current.versions.some((item) => item.version === version.version)
        const next: AgentDetail = {
          ...current,
          status: 'published',
          publishedVersion: version.version,
          version: Math.max(current.version, version.version),
          versions: exists
            ? current.versions.map((item) => (item.version === version.version ? version : item))
            : [version, ...current.versions],
        }
        detail.value = next
        replaceSummary(next)
      }
      return version
    } finally {
      publishing.value = false
    }
  }

  async function setEnabled(id: string, enabled: boolean): Promise<AgentDetail> {
    const updated = enabled ? await agentApi.enable(id) : await agentApi.disable(id)
    if (detail.value?.id === updated.id) detail.value = updated
    replaceSummary(updated)
    return updated
  }

  function resetDetail(): void {
    detail.value = null
    detailError.value = null
    tools.value = null
  }

  return {
    items,
    listLoading,
    listLoaded,
    listError,
    detail,
    detailLoading,
    detailError,
    tools,
    toolsLoading,
    saving,
    publishing,
    stats,
    publishedAgents,
    fetchList,
    fetchDetail,
    fetchTools,
    createAgent,
    saveAgent,
    publishAgent,
    setEnabled,
    resetDetail,
  }
})
