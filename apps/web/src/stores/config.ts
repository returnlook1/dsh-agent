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
  ProjectAgentConfigDto,
  SkillSummaryDto,
} from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { DEFAULT_MODEL, DEFAULT_PROVIDER, uniqueStrings } from '../constants'
import {
  describeApiError,
  getMcpServers,
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
  const provider = ref(DEFAULT_PROVIDER)
  const model = ref(DEFAULT_MODEL)
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

  function applyFields(config: AgentConfig): void {
    selectedSkills.value = uniqueStrings(config.skills)
    selectedMcpServers.value = uniqueStrings(config.mcpServers)
    provider.value = config.provider
    model.value = config.model
    systemPrompt.value = config.systemPrompt
  }

  async function loadCatalogs(): Promise<void> {
    catalogsLoading.value = true
    const problems: string[] = []
    const [skillResult, mcpResult] = await Promise.allSettled([getSkills(), getMcpServers()])

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

    catalogError.value = problems.length > 0 ? problems.join('；') : null
    catalogsLoading.value = false
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
      configError.value = 'Provider 与 Model 不能为空'
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
