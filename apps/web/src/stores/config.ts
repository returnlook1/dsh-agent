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
  getMcpServers,
  getModels,
  getProjectAgentConfig,
  getSkills,
  putProjectAgentConfig,
} from '../services/agent-api'

export const useConfigStore = defineStore('config', () => {
  const projectId = ref('default')

  const skills = ref<SkillSummaryDto[]>([])
  const mcpServers = ref<McpServerSummaryDto[]>([])
  const mcpConfigPath = ref('')

  const selectedSkills = ref<string[]>([])
  const selectedMcpServers = ref<string[]>([])
  /**
   * provider / model 的初值是空串：真正的默认值来自 `GET /api/models`
   * （DSH 运行时里的 provider 顺序与模型目录），前端不写死任何模型名。
   */
  const provider = ref('')
  const model = ref('')

  /** DSH 模型清单（provider + models）。 */
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

  /** 可选的 provider（DSH 注册了什么就显示什么）。 */
  const providerOptions = computed<ProviderOption[]>(() => modelCatalog.value?.providers ?? [])

  /** 当前 provider 下的可选模型。 */
  const modelOptions = computed<ModelOption[]>(() => {
    const current = providerOptions.value.find((item) => item.id === provider.value)
    if (current !== undefined) return current.models
    return providerOptions.value[0]?.models ?? []
  })

  /** 清单是否给出了可用路由（否则不能新建对话）。 */
  const hasUsableModel = computed(() =>
    providerOptions.value.some((item) => item.models.length > 0),
  )

  /** 给 UI 一行提示：清单来源与默认路由。 */
  const modelSummary = computed(() => {
    const catalog = modelCatalog.value
    if (catalog === null) return '尚未加载模型清单'
    const route = catalog.default
    const from = catalog.source === 'live' ? 'DSH' : catalog.source === 'cache' ? '缓存' : '不可用'
    if (route.provider.length === 0) return `模型清单（${from}）没有可用项`
    return `默认 ${route.provider} / ${route.model}（来源：${from}）`
  })

  /** 按清单补全空路由；provider 变了但模型不属于它时，回落到该 provider 的首个模型。 */
  function normaliseRoute(): void {
    const providers = providerOptions.value
    if (providers.length === 0) return
    if (provider.value.length === 0) {
      const fallback = providers.find((item) => item.models.length > 0) ?? providers[0]
      provider.value = fallback?.id ?? ''
    }
    const current = providers.find((item) => item.id === provider.value)
    if (current === undefined) {
      provider.value = providers[0]?.id ?? ''
      model.value = providers[0]?.models[0]?.id ?? ''
      return
    }
    if (!current.models.some((item) => item.id === model.value)) {
      model.value = current.models[0]?.id ?? ''
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
    } else {
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

  /** 切换 provider 时自动把模型切到它的第一项。 */
  function setProvider(next: string): void {
    provider.value = next
    const entry = providerOptions.value.find((item) => item.id === next)
    if (entry !== undefined && !entry.models.some((item) => item.id === model.value)) {
      model.value = entry.models[0]?.id ?? ''
    }
  }

  function setModel(next: string): void {
    model.value = next
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
    const providerValue = provider.value.trim()
    const modelValue = model.value.trim()
    if (providerValue.length === 0 || modelValue.length === 0) {
      configError.value = '请先从 DSH 模型清单中选择 Provider 与 Model'
      return false
    }

    const patch: AgentConfigPatch = {
      skills: uniqueStrings(selectedSkills.value),
      mcpServers: uniqueStrings(selectedMcpServers.value),
      provider: providerValue,
      model: modelValue,
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
          provider: providerValue,
          model: modelValue,
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
    modelSummary,
    setProvider,
    setModel,
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
