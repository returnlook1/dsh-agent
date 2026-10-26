<script setup lang="ts">
import type { AuditQuery } from '@agent-studio/shared'
import { Banner, Button, Input, Modal, Pagination, Select, Table } from '@aifuxi/semi-ui-vue'
import type { TableColumnProps, TableRowAttributes } from '@aifuxi/semi-ui-vue'
import { computed, h, onMounted, ref } from 'vue'

import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { auditApi } from '@/services/agent-api'
import { messageOf, notifyError } from '@/services/feedback'
import { useAgentsStore } from '@/stores/agents'
import { formatDateTime, formatDuration, truncate } from '@/utils/format'
import { IconRefresh, IconSearch } from '@/ui/icons'

interface AuditRow {
  [key: string]: unknown
  id: string
  at: number
  agentId: string
  userId: string
  sessionId: string
  tool: string
  decision: string
  status: string
  argumentsPreview: string
  error: string
  durationMs: number | undefined
}

/** Table 的列类型固定在 Record<string, unknown>，这里做一次显式收窄。 */
function rowOf(record: Record<string, unknown>): AuditRow {
  return record as unknown as AuditRow
}

const agents = useAgentsStore()

const rows = ref<AuditRow[]>([])
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const page = ref(1)
const pageSize = 20
const selected = ref<AuditRow | null>(null)

const filters = ref({
  agentId: '',
  tool: '',
  decision: '',
  range: '24h',
})

const decisionOptions = [
  { value: '', label: '全部决策' },
  { value: 'allow', label: '策略允许' },
  { value: 'approved', label: '人工批准' },
  { value: 'ask', label: '请求审批' },
  { value: 'deny', label: '策略拒绝' },
  { value: 'rejected', label: '人工拒绝' },
  { value: 'cancelled', label: '已取消' },
  { value: 'expired', label: '审批超时' },
]

const rangeOptions = [
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: 'all', label: '不限时间' },
]

const agentOptions = computed(() => [
  { value: '', label: '全部 Agent' },
  ...agents.items.map((agent) => ({ value: agent.id, label: agent.name })),
])

function rangeToFrom(range: string): number | undefined {
  const now = Date.now()
  if (range === '1h') return now - 60 * 60 * 1000
  if (range === '24h') return now - 24 * 60 * 60 * 1000
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000
  return undefined
}

function buildQuery(): AuditQuery {
  const query: AuditQuery = {
    limit: pageSize,
    offset: (page.value - 1) * pageSize,
  }
  if (filters.value.agentId.length > 0) query.agentId = filters.value.agentId
  if (filters.value.tool.trim().length > 0) query.tool = filters.value.tool.trim()
  if (filters.value.decision.length > 0) query.decision = filters.value.decision
  const from = rangeToFrom(filters.value.range)
  if (from !== undefined) query.from = from
  return query
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const result = await auditApi.query(buildQuery())
    total.value = result.total
    rows.value = result.items.map((item) => ({
      id: item.id,
      at: item.at,
      agentId: item.agentId,
      userId: item.userId,
      sessionId: item.sessionId,
      tool: item.tool,
      decision: item.decision,
      status: item.status,
      argumentsPreview: item.argumentsPreview,
      error: item.error ?? '',
      durationMs: item.durationMs,
    }))
  } catch (error) {
    loadError.value = messageOf(error, '加载审计日志失败')
    rows.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

async function search(): Promise<void> {
  page.value = 1
  await load()
}

function resetFilters(): void {
  filters.value = { agentId: '', tool: '', decision: '', range: '24h' }
  void search()
}

function changePage(next: number): void {
  page.value = next
  void load()
}

function openDetail(row: AuditRow): void {
  selected.value = row
}

const columns: TableColumnProps[] = [
  {
    title: '时间',
    dataIndex: 'at',
    width: 160,
    render: (_text, record) => formatDateTime(rowOf(record).at),
  },
  {
    title: 'Agent',
    dataIndex: 'agentId',
    width: 160,
    render: (_text, record) => h('code', {}, rowOf(record).agentId),
  },
  {
    title: '工具',
    dataIndex: 'tool',
    width: 180,
    render: (_text, record) => h('code', {}, rowOf(record).tool),
  },
  {
    title: '决策',
    dataIndex: 'decision',
    width: 120,
    render: (_text, record) =>
      h(StatusTag, { kind: 'audit-decision', value: rowOf(record).decision, size: 'small' }),
  },
  {
    title: '状态',
    dataIndex: 'status',
    width: 110,
    render: (_text, record) =>
      h(StatusTag, { kind: 'audit-status', value: rowOf(record).status, size: 'small' }),
  },
  {
    title: '耗时',
    dataIndex: 'durationMs',
    width: 100,
    render: (_text, record) => formatDuration(rowOf(record).durationMs),
  },
  {
    title: '参数摘要',
    dataIndex: 'argumentsPreview',
    render: (_text, record) => {
      const preview = rowOf(record).argumentsPreview
      return h('span', { class: 'muted mono' }, truncate(preview, 96) || '—')
    },
  },
]

function rowProps(record?: Record<string, unknown>): TableRowAttributes {
  return {
    style: { cursor: 'pointer' },
    onClick: () => {
      if (record !== undefined) openDetail(rowOf(record))
    },
  }
}

onMounted(() => {
  void (async () => {
    try {
      await agents.fetchList()
    } catch (error) {
      notifyError(error, '加载 Agent 列表失败')
    }
    await load()
  })()
})
</script>

<template>
  <div class="page">
    <PageHeader
      title="审计日志"
      description="每一次工具调用都会记录决策、执行状态、参数摘要与耗时。仅管理员可见。"
    >
      <template #actions>
        <Button theme="borderless" type="tertiary" :loading="loading" @click="load">
          <template #icon><IconRefresh /></template>
          刷新
        </Button>
      </template>
    </PageHeader>

    <div class="audit-filters">
      <div class="editor-field">
        <label class="editor-field__label" for="audit-agent">Agent</label>
        <Select
          id="audit-agent"
          :model-value="filters.agentId"
          :option-list="agentOptions"
          :show-clear="false"
          @change="(value: unknown) => (filters.agentId = typeof value === 'string' ? value : '')"
        />
      </div>
      <div class="editor-field">
        <label class="editor-field__label" for="audit-tool">工具</label>
        <Input id="audit-tool" v-model="filters.tool" placeholder="按工具名筛选" show-clear />
      </div>
      <div class="editor-field">
        <label class="editor-field__label" for="audit-decision">决策</label>
        <Select
          id="audit-decision"
          :model-value="filters.decision"
          :option-list="decisionOptions"
          :show-clear="false"
          @change="(value: unknown) => (filters.decision = typeof value === 'string' ? value : '')"
        />
      </div>
      <div class="editor-field">
        <label class="editor-field__label" for="audit-range">时间范围</label>
        <Select
          id="audit-range"
          :model-value="filters.range"
          :option-list="rangeOptions"
          :show-clear="false"
          @change="(value: unknown) => (filters.range = typeof value === 'string' ? value : '24h')"
        />
      </div>
      <div class="toolbar">
        <Button theme="borderless" type="tertiary" @click="resetFilters">重置</Button>
        <Button type="primary" theme="solid" :loading="loading" @click="search">
          <template #icon><IconSearch /></template>
          查询
        </Button>
      </div>
    </div>

    <Banner v-if="loadError" type="danger" title="审计日志加载失败" @close="loadError = ''">
      <template #description>{{ loadError }}</template>
    </Banner>

    <div class="audit-table-wrap">
      <Table
        row-key="id"
        size="middle"
        :columns="columns"
        :data-source="rows"
        :loading="loading"
        :pagination="false"
        :on-row="rowProps"
      >
        <template #empty>
          <EmptyState
            title="没有符合条件的记录"
            description="调整筛选条件后重试；新产生的工具调用会自动记录到这里。"
            compact
          />
        </template>
      </Table>

      <div class="audit-pagination">
        <span class="audit-pagination__total">共 {{ total }} 条记录</span>
        <Pagination
          :current-page="page"
          :page-size="pageSize"
          :total="total"
          :show-total="false"
          :hide-on-single-page="false"
          @change="changePage"
        />
      </div>
    </div>

    <Modal
      :visible="selected !== null"
      title="审计详情"
      :footer="false"
      width="640px"
      @cancel="selected = null"
    >
      <div v-if="selected" class="audit-detail">
        <div class="detail-grid">
          <div class="kv">
            <span class="kv__k">记录时间</span>
            <span class="kv__v">{{ formatDateTime(selected.at) }}</span>
          </div>
          <div class="kv">
            <span class="kv__k">耗时</span>
            <span class="kv__v">{{ formatDuration(selected.durationMs) }}</span>
          </div>
          <div class="kv">
            <span class="kv__k">Agent</span>
            <span class="kv__v"><code>{{ selected.agentId }}</code></span>
          </div>
          <div class="kv">
            <span class="kv__k">工具</span>
            <span class="kv__v"><code>{{ selected.tool }}</code></span>
          </div>
          <div class="kv">
            <span class="kv__k">决策</span>
            <span class="kv__v"><StatusTag kind="audit-decision" :value="selected.decision" size="small" /></span>
          </div>
          <div class="kv">
            <span class="kv__k">状态</span>
            <span class="kv__v"><StatusTag kind="audit-status" :value="selected.status" size="small" /></span>
          </div>
          <div class="kv">
            <span class="kv__k">会话</span>
            <span class="kv__v"><code>{{ selected.sessionId }}</code></span>
          </div>
          <div class="kv">
            <span class="kv__k">用户</span>
            <span class="kv__v"><code>{{ selected.userId }}</code></span>
          </div>
          <div class="kv">
            <span class="kv__k">记录 ID</span>
            <span class="kv__v"><code>{{ selected.id }}</code></span>
          </div>
        </div>

        <div class="audit-detail__section">
          <span class="audit-detail__label">参数摘要</span>
          <pre class="audit-detail__code">{{ selected.argumentsPreview || '（无参数）' }}</pre>
        </div>

        <div v-if="selected.error.length > 0" class="audit-detail__section">
          <span class="audit-detail__label">错误 / 拒绝原因</span>
          <pre class="audit-detail__code">{{ selected.error }}</pre>
        </div>
      </div>
    </Modal>
  </div>
</template>
