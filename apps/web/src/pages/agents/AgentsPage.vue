<script setup lang="ts">
import type { AgentSummary, CreateAgentRequest } from '@agent-studio/shared'
import { Banner, Button, Card, Input, Modal, Select, Spin, TextArea } from '@aifuxi/semi-ui-vue'
import { computed, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'

import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { messageOf, notifyError, notifySuccess } from '@/services/feedback'
import { useAgentsStore } from '@/stores/agents'
import { formatRelative } from '@/utils/format'
import { IconAgents, IconCheck, IconEdit, IconPlus, IconRefresh, IconSearch } from '@/ui/icons'

interface AgentTemplate {
  key: string
  label: string
  description: string
  apply: () => Pick<CreateAgentRequest, 'description' | 'prompt' | 'limits' | 'ui'>
}

const TEMPLATES: readonly AgentTemplate[] = [
  {
    key: 'blank',
    label: '空白 Agent',
    description: '只包含受限运行时的默认配置，工具需要在编辑器中逐项授权。',
    apply: () => ({
      description: '',
      prompt: { system: '', welcome: '' },
      limits: { maxTurns: 20, maxConcurrentRuns: 1, maxRequestsPerHour: 30 },
      ui: { showToolCalls: true, showReasoning: false, allowAttachments: false, showModelSelector: false },
    }),
  },
  {
    key: 'query',
    label: '业务查询助手',
    description: '面向业务系统的数据查询场景，限制轮次并默认展示工具调用过程。',
    apply: () => ({
      description: '按授权范围查询业务数据并给出结论，不执行写操作。',
      prompt: {
        system:
          '你是业务数据查询助手。只使用已授权的工具获取数据；信息不足时先向用户确认查询条件，不要猜测数据。回答需说明数据来源与时间范围。',
        welcome: '请描述你要查询的对象、时间范围和关注指标。',
      },
      limits: { maxTurns: 12, maxConcurrentRuns: 1, maxRequestsPerHour: 60 },
      ui: { showToolCalls: true, showReasoning: false, allowAttachments: false, showModelSelector: false },
    }),
  },
  {
    key: 'analysis',
    label: '分析报告助手',
    description: '在查询结果基础上做统计与归纳，适合值班分析与日报场景。',
    apply: () => ({
      description: '基于已查询的数据做统计分析和结论归纳，输出结构化报告。',
      prompt: {
        system:
          '你是数据分析助手。先确认数据口径，再基于工具返回的真实数据计算，禁止编造数值。输出包含结论、依据和不确定项。',
        welcome: '请提供分析对象与时间区间，我会先取数再给出结论。',
      },
      limits: { maxTurns: 20, maxConcurrentRuns: 1, maxRequestsPerHour: 40 },
      ui: { showToolCalls: true, showReasoning: true, allowAttachments: false, showModelSelector: false },
    }),
  },
]

const router = useRouter()
const agents = useAgentsStore()

const search = ref('')
const statusFilter = ref('all')

const createVisible = ref(false)
const createError = ref('')
const form = reactive({ name: '', description: '', templateKey: 'blank' })
const fieldErrors = reactive({ name: '' })

const statusOptions = [
  { value: 'all', label: '全部状态' },
  { value: 'published', label: '已发布' },
  { value: 'draft', label: '草稿' },
  { value: 'disabled', label: '已停用' },
]

const filteredAgents = computed<AgentSummary[]>(() => {
  const keyword = search.value.trim().toLowerCase()
  return agents.items
    .filter((item) => {
      if (statusFilter.value !== 'all' && item.status !== statusFilter.value) return false
      if (keyword.length === 0) return true
      return (
        item.name.toLowerCase().includes(keyword) ||
        item.description.toLowerCase().includes(keyword) ||
        item.id.toLowerCase().includes(keyword)
      )
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
})

const selectedTemplate = computed(
  () => TEMPLATES.find((item) => item.key === form.templateKey) ?? TEMPLATES[0],
)

const isFiltering = computed(() => search.value.trim().length > 0 || statusFilter.value !== 'all')

async function load(): Promise<void> {
  try {
    await agents.fetchList(true)
  } catch (error) {
    notifyError(error, '加载 Agent 列表失败')
  }
}

onMounted(() => {
  void load()
})

function openAgent(agent: AgentSummary): void {
  void router.push({ name: 'agent-editor', params: { id: agent.id } })
}

function openChat(agent: AgentSummary): void {
  if (agent.status !== 'published') return
  void router.push({ name: 'chat', params: { agentId: agent.id } })
}

async function toggleStatus(agent: AgentSummary): Promise<void> {
  try {
    const enabled = agent.status === 'disabled'
    await agents.setEnabled(agent.id, enabled)
    notifySuccess(enabled ? `已启用 ${agent.name}` : `已停用 ${agent.name}`)
  } catch (error) {
    notifyError(error, '更新状态失败')
  }
}

function resetCreateForm(): void {
  form.name = ''
  form.description = ''
  form.templateKey = 'blank'
  fieldErrors.name = ''
  createError.value = ''
}

function openCreate(): void {
  resetCreateForm()
  createVisible.value = true
}

function applyTemplate(key: string): void {
  form.templateKey = key
  const template = TEMPLATES.find((item) => item.key === key)
  if (template === undefined) return
  form.description = template.apply().description ?? ''
}

async function submitCreate(): Promise<void> {
  createError.value = ''
  fieldErrors.name = form.name.trim().length === 0 ? '请输入 Agent 名称' : ''
  if (fieldErrors.name.length > 0) return
  if (form.name.trim().length > 80) {
    fieldErrors.name = '名称不能超过 80 个字符'
    return
  }
  const template = selectedTemplate.value ?? TEMPLATES[0]
  if (template === undefined) return
  const applied = template.apply()
  const payload: CreateAgentRequest = {
    name: form.name.trim(),
    description: form.description.trim() || applied.description,
    model: { provider: 'deepseek-official', modelId: 'deepseek-v4-flash' },
    prompt: applied.prompt,
    capabilities: { tools: {}, mcpServers: [], skills: [], subagents: false },
    security: {
      shell: false,
      fileRead: false,
      fileWrite: false,
      pluginManagement: false,
      networkAccess: 'restricted',
      dataScope: 'user-authorized',
    },
    limits: applied.limits,
    ui: applied.ui,
  }
  try {
    const created = await agents.createAgent(payload)
    notifySuccess(`已创建 ${created.name}`)
    createVisible.value = false
    await router.push({ name: 'agent-editor', params: { id: created.id } })
  } catch (error) {
    createError.value = messageOf(error, '创建 Agent 失败')
  }
}

function handleStatusChange(value: unknown): void {
  if (typeof value === 'string') statusFilter.value = value
}
</script>

<template>
  <div class="page">
    <PageHeader title="Agent 管理" description="创建、配置、测试和发布智能体。工具授权与运行限制在编辑器中逐项设置。">
      <template #actions>
        <Button theme="borderless" type="tertiary" :loading="agents.listLoading" @click="load">
          <template #icon><IconRefresh /></template>
          刷新
        </Button>
        <Button type="primary" theme="solid" @click="openCreate">
          <template #icon><IconPlus /></template>
          新建 Agent
        </Button>
      </template>
    </PageHeader>

    <div class="stats-grid">
      <Card :bordered="false" class="stat-card">
        <div class="stat-card__label">
          <span class="stat-card__icon" aria-hidden="true"><IconAgents /></span>
          全部 Agent
        </div>
        <div class="stat-card__value">{{ agents.stats.total }}</div>
        <div class="stat-card__hint">包含草稿与已停用配置</div>
      </Card>
      <Card :bordered="false" class="stat-card">
        <div class="stat-card__label">
          <span class="stat-card__icon stat-card__icon--success" aria-hidden="true"><IconCheck /></span>
          已发布
        </div>
        <div class="stat-card__value">{{ agents.stats.published }}</div>
        <div class="stat-card__hint">可被普通用户选择并发起会话</div>
      </Card>
      <Card :bordered="false" class="stat-card">
        <div class="stat-card__label">
          <span class="stat-card__icon stat-card__icon--warning" aria-hidden="true"><IconEdit /></span>
          草稿
        </div>
        <div class="stat-card__value">{{ agents.stats.draft }}</div>
        <div class="stat-card__hint">尚未发布，聊天入口不可用</div>
      </Card>
    </div>

    <div class="filter-bar">
      <Input
        v-model="search"
        class="filter-bar__search"
        placeholder="搜索名称、描述或标识"
        show-clear
      >
        <template #prefix><IconSearch /></template>
      </Input>
      <Select
        :model-value="statusFilter"
        :option-list="statusOptions"
        :show-clear="false"
        style="width: 150px"
        @change="handleStatusChange"
      />
      <span class="subtle">
        共 {{ filteredAgents.length }} 个结果<template v-if="isFiltering">（已筛选）</template>
      </span>
      <div class="filter-bar__spacer" />
    </div>

    <Banner
      v-if="agents.listError"
      type="danger"
      title="Agent 列表加载失败"
      @close="agents.listError = null"
    >
      <template #description>
        {{ agents.listError }}。请确认网关已启动后刷新页面。
      </template>
    </Banner>

    <div v-if="agents.listLoading && agents.items.length === 0" class="agent-grid">
      <div v-for="index in 3" :key="index" class="agent-card agent-card--muted">
        <Spin size="middle" tip="加载中" />
      </div>
    </div>

    <EmptyState
      v-else-if="filteredAgents.length === 0"
      :title="isFiltering ? '没有符合条件的 Agent' : '还没有 Agent'"
      :description="
        isFiltering ? '调整筛选条件，或清空搜索关键词后重试。' : '创建第一个 Agent，配置模型、工具授权与运行限制。'
      "
      :action-label="isFiltering ? '' : '新建 Agent'"
      @action="openCreate"
    />

    <div v-else class="agent-grid">
      <article
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="agent-card"
        :class="{ 'agent-card--muted': agent.status === 'disabled' }"
        @click="openAgent(agent)"
      >
        <div class="agent-card__head">
          <div>
            <RouterLink
              class="agent-card__name agent-card__link"
              :to="{ name: 'agent-editor', params: { id: agent.id } }"
              @click.stop
            >
              {{ agent.name }}
            </RouterLink>
            <div class="agent-card__id">{{ agent.id }}</div>
          </div>
          <StatusTag kind="agent-status" :value="agent.status" />
        </div>

        <p class="agent-card__desc">{{ agent.description || '未填写描述' }}</p>

        <div class="agent-card__meta">
          <span class="agent-card__meta-item">模型 {{ agent.model }}</span>
          <span class="agent-card__meta-item">工具 {{ agent.toolCount }} 个</span>
          <span class="agent-card__meta-item">版本 v{{ agent.version }}</span>
        </div>

        <div class="agent-card__footer">
          <span class="agent-card__updated">更新于 {{ formatRelative(agent.updatedAt) }}</span>
          <div class="agent-card__actions" @click.stop>
            <Button size="small" theme="borderless" type="tertiary" @click="openAgent(agent)">
              编辑
            </Button>
            <Button size="small" theme="borderless" type="tertiary" @click="toggleStatus(agent)">
              {{ agent.status === 'disabled' ? '启用' : '停用' }}
            </Button>
            <Button
              size="small"
              theme="light"
              type="primary"
              :disabled="agent.status !== 'published'"
              @click="openChat(agent)"
            >
              进入聊天
            </Button>
          </div>
        </div>
      </article>
    </div>

    <Modal
      :visible="createVisible"
      title="新建 Agent"
      :footer="false"
      :mask-closable="false"
      width="520px"
      @cancel="createVisible = false"
    >
      <div class="mcp-form">
        <Banner v-if="createError" type="danger" :title="createError" />

        <div class="editor-field">
          <label class="editor-field__label" for="agent-name">
            名称<span class="editor-field__required">*</span>
          </label>
          <Input
            id="agent-name"
            v-model="form.name"
            placeholder="例如：水环境智能助手"
            :max-length="80"
            :validate-status="fieldErrors.name ? 'error' : 'default'"
          />
          <span v-if="fieldErrors.name" class="editor-field__error">{{ fieldErrors.name }}</span>
          <span v-else class="editor-field__hint">标识由服务端根据名称生成，发布后不建议修改。</span>
        </div>

        <div class="editor-field">
          <label class="editor-field__label" for="agent-template">模板</label>
          <Select
            id="agent-template"
            :model-value="form.templateKey"
            :option-list="TEMPLATES.map((item) => ({ value: item.key, label: item.label }))"
            :show-clear="false"
            @change="(value: unknown) => typeof value === 'string' && applyTemplate(value)"
          />
          <span class="editor-field__hint">{{ selectedTemplate?.description }}</span>
        </div>

        <div class="editor-field">
          <label class="editor-field__label" for="agent-description">描述</label>
          <TextArea
            id="agent-description"
            v-model="form.description"
            placeholder="一句话说明这个 Agent 能做什么"
            :autosize="{ minRows: 2, maxRows: 4 }"
            :max-length="400"
          />
        </div>

        <div class="toolbar">
          <Button theme="borderless" type="tertiary" @click="createVisible = false">取消</Button>
          <Button type="primary" theme="solid" :loading="agents.saving" @click="submitCreate">
            创建并进入编辑器
          </Button>
        </div>
      </div>
    </Modal>
  </div>
</template>
