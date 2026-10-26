/**
 * 配置面板状态：项目默认能力（Skills / MCP / 模型 / 系统提示词）。
 *
 * 表单值既用于「保存为项目默认」（PUT），也用于「新建对话」的显式覆盖项。
 * 切换项目时会重新加载服务端配置；所有请求错误都落在此处的 error 字段，
 * 由面板用 Banner 展示。
 */
import type {
  AgentConfig,
  AgentConfigPatch,
  McpProbeResponse,
  McpServerSummaryDto,
  ModelCatalogResponse,
  ModelOption,
  ProjectAgentConfigDto,
  ProviderOption,
  SkillSummaryDto,
} from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { uniqueStrings } from '../constants'
import {
  describeApiError,
  describeMcpProbeError,
  describeMcpProbeFailure,
  getMcpServers,
  getMcpServerTools,
  getModels,
  getProjectAgentConfig,
  getSkills,
  putProjectAgentConfig,
  testMcpServer,
} from '../services/agent-api'

/** 单个 MCP 服务器的探测状态（行内测试 + 工具预览共用）。 */
export interface McpProbeState {
  phase: 'testing' | 'success' | 'error'
  result: McpProbeResponse | null
  error: string | null
  testedAt: number
}

export type McpProbeMode = 'test' | 'tools'

export const useConfigStore = defineStore('config', () => {
  const projectId = ref('default')

  const skills = ref<SkillSummaryDto[]>([])
  const mcpServers = ref<McpServerSummaryDto[]>([])
  const mcpConfigPath = ref('')
  /** `GET /api/mcp-servers` 的 `dshSource`（从既有 DSH Profile 导入时存在）。 */
  const mcpDshSource = ref('')

  /** 每个 MCP 服务器的探测状态（按 serverId 索引）。 */
  const mcpProbeStates = ref<Record<string, McpProbeState>>({})
  /** 同一服务器同一时刻只允许一个探测请求；后来的调用复用同一个 Promise。 */
  const mcpProbeInflight = new Map<string, Promise<McpProbeResponse | null>>()

  const selectedSkills = ref<string[]>([])
  const selectedMcpServers = ref<string[]>([])
  /**
   * 供应商与模型由 DSH 统一管理：前端只**展示** DSH 的默认路由，不提供选择。
   * 这里保留字段用于显示会话快照里冻结的路由。
   */
  const provider = ref('')
  const model = ref('')

  /** DSH 模型清单（只读信息：provider + models + 默认路由来源）。 */
  const modelCatalog = ref<ModelCatalogResponse | null>(null)
  const modelsLoading = ref(false)
  const modelsError = ref<string | null>(null)
  const systemPrompt = ref('')

  const projectConfig = ref<ProjectAgentConfigDto | null>(null)

  const catalogsLoading = ref(false)
  const configLoading = ref(false)
  const saving = ref(false)
  const catalogError = ref<string | null>(null)
  const configError = ref<string | null>(null)

  /** 防止快速切换项目时旧响应覆盖新状态。 */
  let configRequestSeq = 0

  const skillOptions = computed(() => [...skills.value].sort((a, b) => a.name.localeCompare(b.name)))

  /** DSH 报告的 provider 列表（只读展示）。 */
  const providerOptions = computed<ProviderOption[]>(() => modelCatalog.value?.providers ?? [])

  /** 当前会话/项目所在的 provider 下的模型（只读展示）。 */
  const modelOptions = computed<ModelOption[]>(() => {
    const current = providerOptions.value.find((item) => item.id === provider.value)
    if (current !== undefined) return current.models
    return providerOptions.value[0]?.models ?? []
  })

  /** 清单是否给出了可用路由（否则不能新建对话）。 */
  const hasUsableModel = computed(() =>
    providerOptions.value.some((item) => item.models.length > 0),
  )

  /** DSH 的默认路由（只读；前端不能改）。 */
  const dshRoute = computed(() => modelCatalog.value?.default ?? { provider: '', model: '' })

  /** 路由来源说明：DSH 配置的默认模型 / 清单第一项。 */
  const routeSourceLabel = computed(() =>
    modelCatalog.value?.defaultSource === 'dsh-default-model' ? 'DSH 配置的默认模型' : 'DSH 模型清单第一项',
  )

  /** 给 UI 一行提示：路由由 DSH 决定。 */
  const modelSummary = computed(() => {
    const catalog = modelCatalog.value
    if (catalog === null) return '尚未加载模型清单'
    const route = catalog.default
    const from = catalog.source === 'live' ? 'DSH' : catalog.source === 'cache' ? '缓存' : '不可用'
    if (route.provider.length === 0) return `模型清单（${from}）没有可用项`
    return `路由：${route.provider} / ${route.model}（${routeSourceLabel.value}，来源：${from}）`
  })

  /** 按清单补全空路由；provider 变了但模型不属于它时，回落到该 provider 的首个模型。 */
  /**
   * 路由只读：展示时一律对齐 DSH 当前默认路由（供应商与模型由 DSH 统一管理）。
   * 仅影响展示；保存项目配置不再回写 provider/model。
   */
  function normaliseRoute(): void {
    const route = dshRoute.value
    if (route.provider.length > 0) {
      provider.value = route.provider
      model.value = route.model
    }
  }

  function applyFields(config: AgentConfig): void {
    selectedSkills.value = uniqueStrings(config.skills)
    selectedMcpServers.value = uniqueStrings(config.mcpServers)
    provider.value = config.provider
    model.value = config.model
    systemPrompt.value = config.systemPrompt
    // 服务端已经把空路由补成 DSH 默认值；这里再兜一次底（清单后到/配置缺失时）。
    normaliseRoute()
  }

  async function loadCatalogs(): Promise<void> {
    catalogsLoading.value = true
    modelsLoading.value = true
    const problems: string[] = []
    const [skillResult, mcpResult, modelResult] = await Promise.allSettled([
      getSkills(),
      getMcpServers(),
      getModels(),
    ])

    if (skillResult.status === 'fulfilled') {
      skills.value = skillResult.value.skills
    } else {
      problems.push(`Skills 清单：${describeApiError(skillResult.reason)}`)
    }
    if (mcpResult.status === 'fulfilled') {
      mcpServers.value = mcpResult.value.servers
      mcpConfigPath.value = mcpResult.value.configPath
      mcpDshSource.value = mcpResult.value.dshSource ?? ''
    } else {
      mcpDshSource.value = ''
      problems.push(`MCP 清单：${describeApiError(mcpResult.reason)}`)
    }
    if (modelResult.status === 'fulfilled') {
      modelCatalog.value = modelResult.value
      modelsError.value = modelResult.value.error ?? null
      normaliseRoute()
    } else {
      modelsError.value = describeApiError(modelResult.reason)
      problems.push(`模型清单：${modelsError.value}`)
    }

    catalogError.value = problems.length > 0 ? problems.join('；') : null
    catalogsLoading.value = false
    modelsLoading.value = false
  }

  /** 重新向 DSH 询问模型清单（换 Provider / baseURL 后用）。 */
  async function refreshModels(): Promise<void> {
    modelsLoading.value = true
    modelsError.value = null
    try {
      modelCatalog.value = await getModels(true)
      modelsError.value = modelCatalog.value.error ?? null
      normaliseRoute()
    } catch (error) {
      modelsError.value = describeApiError(error)
    } finally {
      modelsLoading.value = false
    }
  }

  function setProbeState(serverId: string, state: McpProbeState): void {
    mcpProbeStates.value = { ...mcpProbeStates.value, [serverId]: state }
  }

  /** 清掉某个服务器的探测状态（行内错误 / SideSheet Banner 关闭）。 */
  function clearMcpProbeState(serverId: string): void {
    const next = { ...mcpProbeStates.value }
    delete next[serverId]
    mcpProbeStates.value = next
  }

  /**
   * 测试 MCP 服务器（`POST /mcp-servers/:id/test`）或重新拉取工具清单
   * （`GET /mcp-servers/:id/tools`）。
   *
   * - 单次最长可达 ~25s，因此请求异步执行，状态按 serverId 独立维护；
   * - 同一服务器并发点击时复用同一个 Promise，绝不重复发请求；
   * - 失败原因（超时 / 连接失败 / 契约错误）写进 `mcpProbeStates` 供行内展开。
   */
  async function probeMcpServer(
    serverId: string,
    mode: McpProbeMode = 'test',
  ): Promise<McpProbeResponse | null> {
    const inflight = mcpProbeInflight.get(serverId)
    if (inflight !== undefined) return inflight

    const previous = mcpProbeStates.value[serverId]
    setProbeState(serverId, {
      phase: 'testing',
      result: previous?.result ?? null,
      error: null,
      testedAt: previous?.testedAt ?? 0,
    })

    const request = (async (): Promise<McpProbeResponse | null> => {
      try {
        const probe = mode === 'tools' ? await getMcpServerTools(serverId) : await testMcpServer(serverId)
        setProbeState(serverId, {
          phase: probe.ok ? 'success' : 'error',
          result: probe,
          error: probe.ok ? null : describeMcpProbeFailure(probe),
          testedAt: Date.now(),
        })
        return probe
      } catch (error) {
        setProbeState(serverId, {
          phase: 'error',
          result: null,
          error: describeMcpProbeError(error),
          testedAt: Date.now(),
        })
        return null
      } finally {
        mcpProbeInflight.delete(serverId)
      }
    })()

    mcpProbeInflight.set(serverId, request)
    return request
  }

  async function loadProjectConfig(project?: string): Promise<void> {
    if (project !== undefined) projectId.value = project
    const id = projectId.value.trim()
    if (id.length === 0) {
      configError.value = '请先填写项目 ID'
      return
    }
    const seq = ++configRequestSeq
    configLoading.value = true
    configError.value = null
    try {
      const loaded = await getProjectAgentConfig(id)
      if (seq !== configRequestSeq) return
      projectConfig.value = loaded
      applyFields(loaded)
    } catch (error) {
      if (seq !== configRequestSeq) return
      configError.value = `加载项目配置失败：${describeApiError(error)}`
    } finally {
      if (seq === configRequestSeq) configLoading.value = false
    }
  }

  async function saveProjectConfig(): Promise<boolean> {
    if (saving.value) return false
    const id = projectId.value.trim()
    if (id.length === 0) {
      configError.value = '请先填写项目 ID'
      return false
    }
    // 供应商与模型由 DSH 统一管理：这里只提交能力与提示词。
    const patch: AgentConfigPatch = {
      skills: uniqueStrings(selectedSkills.value),
      mcpServers: uniqueStrings(selectedMcpServers.value),
      systemPrompt: systemPrompt.value,
    }

    saving.value = true
    configError.value = null
    try {
      const saved = await putProjectAgentConfig(id, patch)
      const next: ProjectAgentConfigDto =
        saved ?? {
          projectId: id,
          ...patch,
          skills: patch.skills ?? [],
          mcpServers: patch.mcpServers ?? [],
          provider: provider.value,
          model: model.value,
          systemPrompt: systemPrompt.value,
          saved: true,
          updatedAt: Date.now(),
        }
      projectConfig.value = next
      return true
    } catch (error) {
      configError.value = `保存项目配置失败：${describeApiError(error)}`
      return false
    } finally {
      saving.value = false
    }
  }

  function toggleSkill(name: string): void {
    selectedSkills.value = selectedSkills.value.includes(name)
      ? selectedSkills.value.filter((item) => item !== name)
      : [...selectedSkills.value, name]
  }

  function selectAllSkills(): void {
    selectedSkills.value = skills.value.map((skill) => skill.name)
  }

  function clearSkills(): void {
    selectedSkills.value = []
  }

  function clearConfigError(): void {
    configError.value = null
  }

  function clearCatalogError(): void {
    catalogError.value = null
  }

  return {
    projectId,
    skills,
    skillOptions,
    mcpServers,
    mcpConfigPath,
    mcpDshSource,
    mcpProbeStates,
    probeMcpServer,
    clearMcpProbeState,
    selectedSkills,
    selectedMcpServers,
    provider,
    model,
    providerOptions,
    modelOptions,
    modelCatalog,
    modelsLoading,
    modelsError,
    hasUsableModel,
    dshRoute,
    routeSourceLabel,
    modelSummary,
    refreshModels,
    systemPrompt,
    projectConfig,
    catalogsLoading,
    configLoading,
    saving,
    catalogError,
    configError,
    loadCatalogs,
    loadProjectConfig,
    saveProjectConfig,
    toggleSkill,
    selectAllSkills,
    clearSkills,
    clearConfigError,
    clearCatalogError,
  }
})
