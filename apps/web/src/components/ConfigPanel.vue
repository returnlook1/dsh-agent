<script setup lang="ts">
import { Banner, Button, Card, Input, Select, Spin, Tag, TextArea, Typography } from '@aifuxi/semi-ui-vue'
import { computed, ref } from 'vue'

import McpSelect from '@/components/McpSelect.vue'
import SkillSelect from '@/components/SkillSelect.vue'
import { useConfigStore } from '@/stores/config'
import { useConversationStore } from '@/stores/conversation'
import { useUiStore } from '@/stores/ui'
import { formatDateTime } from '@/utils/format'

const emit = defineEmits<{ create: [] }>()

const config = useConfigStore()
const conversation = useConversationStore()
const ui = useUiStore()

const promptOpen = ref(config.systemPrompt.length > 0)

const promptSummary = computed(() =>
  config.systemPrompt.length > 0 ? `已填写 ${config.systemPrompt.length} 字` : '未设置（使用服务端默认提示词）',
)
const projectStateLabel = computed(() => {
  const project = config.projectConfig
  if (project === null) return null
  return project.saved ? '已保存' : '未保存'
})

async function loadProject(): Promise<void> {
  await config.loadProjectConfig()
  if (config.configError === null && !config.configLoading) {
    void conversation.loadHistory(config.projectId)
  }
}

async function save(): Promise<void> {
  const ok = await config.saveProjectConfig()
  if (ok) ui.notifySuccess('项目默认配置已保存')
  else ui.notifyError(config.configError ?? '保存项目配置失败')
}

/** 重新向 DSH 询问模型清单（换 Provider / baseURL 后无需重启服务）。 */
async function refreshModels(): Promise<void> {
  await config.refreshModels()
  if (config.modelsError === null) ui.notifySuccess('模型清单已刷新')
  else ui.notifyError(config.modelsError)
}
</script>

<template>
  <Card class="config-card" title="项目配置">
    <div class="config-body">
      <Banner
        v-if="config.configError"
        type="danger"
        title="项目配置请求失败"
        @close="config.clearConfigError()"
      >
        <template #description>{{ config.configError }}</template>
      </Banner>
      <Banner
        v-if="config.catalogError"
        type="warning"
        title="能力清单加载不完整"
        @close="config.clearCatalogError()"
      >
        <template #description>{{ config.catalogError }}</template>
      </Banner>

      <div class="field">
        <label class="field__label" for="project-id">项目</label>
        <div class="project-row">
          <Input
            id="project-id"
            v-model="config.projectId"
            placeholder="default"
            :disabled="config.configLoading"
            @enter-press="loadProject"
          />
          <Button
            size="small"
            theme="borderless"
            :loading="config.configLoading"
            @click="loadProject"
          >
            加载
          </Button>
        </div>
        <div class="project-state">
          <Tag
            v-if="projectStateLabel !== null"
            size="small"
            type="light"
            :color="config.projectConfig?.saved ? 'green' : 'grey'"
          >
            {{ projectStateLabel }}
          </Tag>
          <span v-if="config.projectConfig?.updatedAt" class="field__hint">
            {{ formatDateTime(config.projectConfig.updatedAt) }} 更新
          </span>
          <Spin v-if="config.configLoading" size="small" />
        </div>
        <p class="field__hint">加载 `GET /projects/:id/agent-config`；保存后成为该项目的默认能力。</p>
      </div>

      <div class="field">
        <div class="field__head">
          <span class="field__label">
            Skills
            <Tag size="small" type="light" color="blue">{{ config.selectedSkills.length }}</Tag>
          </span>
          <span class="field__actions">
            <Button
              size="small"
              theme="borderless"
              :disabled="config.catalogsLoading || config.skills.length === 0"
              @click="config.selectAllSkills()"
            >
              全选
            </Button>
            <Button
              size="small"
              theme="borderless"
              :disabled="config.selectedSkills.length === 0"
              @click="config.clearSkills()"
            >
              清空
            </Button>
          </span>
        </div>
        <SkillSelect
          :model-value="config.selectedSkills"
          :skills="config.skillOptions"
          :loading="config.catalogsLoading"
          @update:model-value="config.selectedSkills = $event"
        />
      </div>

      <div class="field">
        <div class="field__head">
          <span class="field__label">
            MCP Servers
            <Tag size="small" type="light" color="cyan">{{ config.selectedMcpServers.length }}</Tag>
          </span>
        </div>
        <McpSelect
          :model-value="config.selectedMcpServers"
          :servers="config.mcpServers"
          :loading="config.catalogsLoading"
          @update:model-value="config.selectedMcpServers = $event"
        />
        <p v-if="config.mcpConfigPath.length > 0" class="field__hint">
          只读列表，来源：{{ config.mcpConfigPath }}
        </p>
      </div>

      <div class="field">
        <div class="field__head">
          <span class="field__label">Provider / Model</span>
          <Button size="small" theme="borderless" :loading="config.modelsLoading" @click="refreshModels">
            从 DSH 刷新
          </Button>
        </div>
        <div class="model-route">
          <Select
            class="model-route__provider"
            :model-value="config.provider"
            :loading="config.modelsLoading"
            :disabled="config.providerOptions.length === 0"
            filter
            placeholder="选择 Provider"
            @update:model-value="config.setProvider(String($event ?? ''))"
          >
            <Select.Option v-for="option in config.providerOptions" :key="option.id" :value="option.id">
              {{ option.name }}（{{ option.id }}）
            </Select.Option>
          </Select>
          <Select
            class="model-route__model"
            :model-value="config.model"
            :loading="config.modelsLoading"
            :disabled="config.modelOptions.length === 0"
            filter
            placeholder="选择模型"
            @update:model-value="config.setModel(String($event ?? ''))"
          >
            <Select.Option v-for="option in config.modelOptions" :key="option.id" :value="option.id">
              {{ option.name }}（{{ option.id }}）
            </Select.Option>
          </Select>
        </div>
        <p class="field__hint">{{ config.modelSummary }}</p>
        <p v-if="config.modelsError" class="field__hint field__hint--danger">{{ config.modelsError }}</p>
        <!-- 只有"清单取到了但里面没有任何模型"才提示检查凭据；请求失败时上面已经有原因 -->
        <p
          v-if="config.modelCatalog !== null && !config.hasUsableModel"
          class="field__hint field__hint--danger"
        >
          DSH 没有报告可用的 provider/model，请检查 Provider 凭据或 baseURL（服务端配置）。
        </p>
      </div>

      <div class="field">
        <div class="field__head">
          <span class="field__label">系统提示词</span>
          <Button size="small" theme="borderless" @click="promptOpen = !promptOpen">
            {{ promptOpen ? '收起' : '展开' }}
          </Button>
        </div>
        <TextArea
          v-if="promptOpen"
          v-model="config.systemPrompt"
          :autosize="{ minRows: 3, maxRows: 8 }"
          :max-length="20000"
          show-counter
          resize="none"
          placeholder="留空时使用运行时默认提示词"
        />
        <p v-else class="field__hint">{{ promptSummary }}</p>
      </div>

      <div class="config-actions">
        <Button block :loading="config.saving" :disabled="config.configLoading" @click="save">
          保存为项目默认
        </Button>
        <Button
          block
          type="primary"
          :loading="conversation.creating"
          :disabled="config.projectId.trim().length === 0 || !config.hasUsableModel"
          @click="emit('create')"
        >
          新建对话
        </Button>
      </div>

      <Typography.Text type="tertiary" size="small" class="config-note">
        新建对话会带上左侧当前选择（不继承项目默认，避免取消勾选的技能被并集加回）。
      </Typography.Text>
    </div>
  </Card>
</template>
