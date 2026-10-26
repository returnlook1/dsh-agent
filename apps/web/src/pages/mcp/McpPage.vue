<script setup lang="ts">
import type { McpServerConfig, McpTransport } from '@agent-studio/shared'
import {
  Banner,
  Button,
  Input,
  Modal,
  Select,
  Switch,
  Table,
  Tag,
  TextArea,
} from '@aifuxi/semi-ui-vue'
import type { TableColumnProps } from '@aifuxi/semi-ui-vue'
import { computed, h, onMounted, reactive, ref } from 'vue'

import EmptyState from '@/components/EmptyState.vue'
import PageHeader from '@/components/PageHeader.vue'
import StatusTag from '@/components/StatusTag.vue'
import { messageOf, notifyError, notifySuccess } from '@/services/feedback'
import { toMcpConfig, useMcpStore } from '@/stores/mcp'
import { formatRelative } from '@/utils/format'
import { IconEdit, IconPlus, IconRefresh, IconTrash } from '@/ui/icons'

interface McpRow {
  [key: string]: unknown
  id: string
  name: string
  transport: McpTransport
  target: string
  hint: string
  readOnly: boolean
  enabled: boolean
  status: 'unknown' | 'ok' | 'error'
  lastError: string
}

/** Table 的列类型固定在 Record<string, unknown>，这里做一次显式收窄。 */
function rowOf(record: Record<string, unknown>): McpRow {
  return record as unknown as McpRow
}

interface FormState {
  id: string
  name: string
  transport: McpTransport
  command: string
  argsText: string
  url: string
  envKeysText: string
  enabled: boolean
  readOnly: boolean
}

const mcp = useMcpStore()

const formVisible = ref(false)
const editingId = ref<string | null>(null)
const form = reactive<FormState>({
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  url: '',
  envKeysText: '',
  enabled: true,
  readOnly: true,
})
const errors = ref<Record<string, string>>({})
const submitError = ref('')
const pendingDelete = ref<McpRow | null>(null)
const deleting = ref(false)

const transportOptions = [
  { value: 'stdio', label: 'stdio — 本地子进程' },
  { value: 'sse', label: 'SSE — 服务端事件流' },
  { value: 'http', label: 'HTTP — 流式 HTTP' },
]

const rows = computed<McpRow[]>(() =>
  mcp.servers.map((server) => {
    const config = toMcpConfig(server)
    const target =
      config.transport === 'stdio'
        ? [config.command ?? '', ...config.args].filter((part) => part.length > 0).join(' ')
        : config.url ?? ''
    const hintParts: string[] = []
    if (config.args.length > 0) hintParts.push(`args ${config.args.length} 项`)
    if (config.envKeys.length > 0) hintParts.push(`env ${config.envKeys.length} 项`)
    if (server.createdAt > 0) hintParts.push(`更新于 ${formatRelative(server.updatedAt)}`)
    const test = mcp.testResults[server.id]
    const status: McpRow['status'] =
      test !== undefined ? (test.ok ? 'ok' : 'error') : server.status ?? 'unknown'
    return {
      id: server.id,
      name: server.name,
      transport: config.transport,
      target,
      hint: hintParts.join(' · '),
      readOnly: config.readOnly,
      enabled: config.enabled,
      status,
      lastError: test?.error ?? server.lastError ?? '',
    }
  }),
)

async function load(): Promise<void> {
  try {
    await mcp.fetchList(true)
  } catch (error) {
    notifyError(error, '加载 MCP 服务器失败')
  }
}

onMounted(() => {
  void load()
})

function resetForm(): void {
  form.id = ''
  form.name = ''
  form.transport = 'stdio'
  form.command = ''
  form.argsText = ''
  form.url = ''
  form.envKeysText = ''
  form.enabled = true
  form.readOnly = true
  errors.value = {}
  submitError.value = ''
}

function openCreate(): void {
  resetForm()
  editingId.value = null
  formVisible.value = true
}

function openEdit(row: McpRow): void {
  const server = mcp.servers.find((item) => item.id === row.id)
  if (server === undefined) return
  const config = toMcpConfig(server)
  form.id = config.id
  form.name = config.name
  form.transport = config.transport
  form.command = config.command ?? ''
  form.argsText = config.args.join('\n')
  form.url = config.url ?? ''
  form.envKeysText = config.envKeys.join('\n')
  form.enabled = config.enabled
  form.readOnly = config.readOnly
  errors.value = {}
  submitError.value = ''
  editingId.value = config.id
  formVisible.value = true
}

function splitLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

function validate(): boolean {
  const next: Record<string, string> = {}
  if (form.id.trim().length === 0) next.id = '请输入服务器标识'
  else if (!/^[a-z0-9][a-z0-9-_]*$/.test(form.id.trim())) {
    next.id = '标识只能包含小写字母、数字、- 和 _，且以字母或数字开头'
  } else if (form.id.trim().length > 64) next.id = '标识不能超过 64 个字符'
  if (form.name.trim().length === 0) next.name = '请输入名称'
  else if (form.name.trim().length > 80) next.name = '名称不能超过 80 个字符'
  if (form.transport === 'stdio') {
    if (form.command.trim().length === 0) next.command = 'stdio 传输需要填写启动命令'
  } else {
    if (form.url.trim().length === 0) next.url = '请填写服务地址'
    else {
      try {
        const parsed = new URL(form.url.trim())
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          next.url = '仅支持 http(s) 地址'
        }
      } catch {
        next.url = '地址格式不正确'
      }
    }
  }
  errors.value = next
  return Object.keys(next).length === 0
}

async function submit(): Promise<void> {
  submitError.value = ''
  if (!validate()) return
  const payload: McpServerConfig = {
    id: form.id.trim(),
    name: form.name.trim(),
    transport: form.transport,
    args: splitLines(form.argsText),
    envKeys: splitLines(form.envKeysText),
    enabled: form.enabled,
    readOnly: form.readOnly,
  }
  if (form.transport === 'stdio') payload.command = form.command.trim()
  else payload.url = form.url.trim()

  try {
    if (editingId.value === null) {
      await mcp.create(payload)
      notifySuccess('已新增 MCP 服务器')
    } else {
      await mcp.update(editingId.value, payload)
      notifySuccess('已保存 MCP 服务器')
    }
    formVisible.value = false
  } catch (error) {
    submitError.value = messageOf(error, '保存 MCP 服务器失败')
  }
}

async function toggleEnabled(row: McpRow, checked: boolean): Promise<void> {
  try {
    await mcp.setEnabled(row.id, checked)
    notifySuccess(checked ? `已启用 ${row.name}` : `已停用 ${row.name}`)
  } catch (error) {
    notifyError(error, '更新启用状态失败')
  }
}

async function testConnection(row: McpRow): Promise<void> {
  try {
    const result = await mcp.test(row.id)
    if (result.ok) {
      const count = result.tools?.length ?? 0
      notifySuccess(`连接正常，发现 ${count} 个工具`)
    } else {
      notifyError(new Error(result.error ?? '连接失败'))
    }
  } catch (error) {
    notifyError(error, '测试连接失败')
  }
}

async function testCurrent(): Promise<void> {
  const id = editingId.value
  if (id === null) return
  try {
    const result = await mcp.test(id)
    if (result.ok) {
      const count = result.tools?.length ?? 0
      notifySuccess(`连接正常，发现 ${count} 个工具`)
    } else {
      notifyError(new Error(result.error ?? '连接失败'))
    }
  } catch (error) {
    notifyError(error, '测试连接失败')
  }
}

async function confirmDelete(): Promise<void> {
  const row = pendingDelete.value
  if (row === null) return
  deleting.value = true
  try {
    await mcp.remove(row.id)
    notifySuccess(`已删除 ${row.name}`)
    pendingDelete.value = null
  } catch (error) {
    notifyError(error, '删除失败')
  } finally {
    deleting.value = false
  }
}

function handleTransport(value: unknown): void {
  if (value === 'stdio' || value === 'sse' || value === 'http') form.transport = value
}

const columns: TableColumnProps[] = [
  {
    title: '名称',
    dataIndex: 'name',
    render: (_text, record) => {
      const row = rowOf(record)
      return h('div', { class: 'mcp-target' }, [
        h('span', { class: 'mcp-target__primary' }, row.name),
        h('span', { class: 'mcp-target__secondary' }, row.id),
      ])
    },
  },
  {
    title: '传输',
    dataIndex: 'transport',
    width: 110,
    render: (_text, record) =>
      h(StatusTag, { kind: 'transport', value: rowOf(record).transport, size: 'small' }),
  },
  {
    title: '连接目标',
    dataIndex: 'target',
    render: (_text, record) => {
      const row = rowOf(record)
      return h('div', { class: 'mcp-target' }, [
        h('span', { class: 'mcp-target__primary' }, row.target || '—'),
        h('span', { class: 'mcp-target__secondary' }, row.hint),
      ])
    },
  },
  {
    title: '读写',
    dataIndex: 'readOnly',
    width: 90,
    render: (_text, record) => {
      const row = rowOf(record)
      return h(Tag, { type: 'light', color: row.readOnly ? 'grey' : 'orange', size: 'small' }, () =>
        row.readOnly ? '只读' : '可写',
      )
    },
  },
  {
    title: '启用',
    dataIndex: 'enabled',
    width: 80,
    render: (_text, record) => {
      const row = rowOf(record)
      return h(Switch, {
        modelValue: row.enabled,
        size: 'small',
        disabled: mcp.saving,
        onChange: (checked: boolean) => {
          void toggleEnabled(row, checked)
        },
      })
    },
  },
  {
    title: '健康状态',
    dataIndex: 'status',
    width: 150,
    render: (_text, record) => {
      const row = rowOf(record)
      return h('div', { class: 'mcp-target' }, [
        h(StatusTag, { kind: 'mcp-status', value: row.status, size: 'small' }),
        row.status === 'error' && row.lastError.length > 0
          ? h('span', { class: 'mcp-target__secondary' }, row.lastError)
          : null,
      ])
    },
  },
  {
    title: '操作',
    width: 210,
    render: (_text, record) => {
      const row = rowOf(record)
      return h('div', { class: 'row-actions' }, [
        h(
          Button,
          {
            size: 'small',
            theme: 'borderless',
            type: 'tertiary',
            loading: mcp.testingId === row.id,
            onClick: () => {
              void testConnection(row)
            },
          },
          () => '测试',
        ),
        h(
          Button,
          {
            size: 'small',
            theme: 'borderless',
            type: 'tertiary',
            onClick: () => openEdit(row),
          },
          () => [h(IconEdit), ' 编辑'],
        ),
        h(
          Button,
          {
            size: 'small',
            theme: 'borderless',
            type: 'danger',
            onClick: () => {
              pendingDelete.value = row
            },
          },
          () => [h(IconTrash), ' 删除'],
        ),
      ])
    },
  },
]
</script>

<template>
  <div class="page">
    <PageHeader
      title="MCP 管理"
      description="配置 MCP 服务器并验证连通性。Agent 只会挂载其配置白名单内的服务器，工具仍需逐项授权。"
    >
      <template #actions>
        <Button theme="borderless" type="tertiary" :loading="mcp.loading" @click="load">
          <template #icon><IconRefresh /></template>
          刷新
        </Button>
        <Button type="primary" theme="solid" @click="openCreate">
          <template #icon><IconPlus /></template>
          新增服务器
        </Button>
      </template>
    </PageHeader>

    <Banner type="info" title="readOnly 仅作为提示">
      <template #description>
        是否允许写操作最终由 MCP 工具在「工具能力」页的授权决定；readOnly 打开时，网关在测试连接时不会暴露写类工具。
      </template>
    </Banner>

    <Banner v-if="mcp.loadError" type="danger" :title="mcp.loadError" />

    <EmptyState
      v-if="!mcp.loading && mcp.servers.length === 0"
      title="尚未配置 MCP 服务器"
      description="新增 stdio 或 SSE / HTTP 服务器后，即可在 Agent 编辑器中按工具逐项授权。"
      action-label="新增服务器"
      @action="openCreate"
    />

    <div v-else class="surface">
      <Table
        row-key="id"
        size="middle"
        :columns="columns"
        :data-source="rows"
        :loading="mcp.loading"
        :pagination="false"
      />
    </div>

    <Modal
      :visible="formVisible"
      :title="editingId === null ? '新增 MCP 服务器' : '编辑 MCP 服务器'"
      :footer="false"
      :mask-closable="false"
      width="620px"
      @cancel="formVisible = false"
    >
      <div class="mcp-form">
        <Banner v-if="submitError" type="danger" :title="submitError" />

        <div class="mcp-form__grid">
          <div class="editor-field">
            <label class="editor-field__label" for="mcp-id">
              标识<span class="editor-field__required">*</span>
            </label>
            <Input
              id="mcp-id"
              v-model="form.id"
              :disabled="editingId !== null"
              placeholder="例如：site-datasource"
              :validate-status="errors.id ? 'error' : 'default'"
            />
            <span v-if="errors.id" class="editor-field__error">{{ errors.id }}</span>
            <span v-else class="editor-field__hint">小写字母、数字、- 和 _，创建后不可修改。</span>
          </div>

          <div class="editor-field">
            <label class="editor-field__label" for="mcp-name">
              名称<span class="editor-field__required">*</span>
            </label>
            <Input
              id="mcp-name"
              v-model="form.name"
              placeholder="例如：监测数据源"
              :max-length="80"
              :validate-status="errors.name ? 'error' : 'default'"
            />
            <span v-if="errors.name" class="editor-field__error">{{ errors.name }}</span>
          </div>
        </div>

        <div class="editor-field">
          <label class="editor-field__label" for="mcp-transport">传输方式</label>
          <Select
            id="mcp-transport"
            :model-value="form.transport"
            :option-list="transportOptions"
            :show-clear="false"
            @change="handleTransport"
          />
        </div>

        <template v-if="form.transport === 'stdio'">
          <div class="editor-field">
            <label class="editor-field__label" for="mcp-command">
              启动命令<span class="editor-field__required">*</span>
            </label>
            <Input
              id="mcp-command"
              v-model="form.command"
              placeholder="例如：node"
              :validate-status="errors.command ? 'error' : 'default'"
            />
            <span v-if="errors.command" class="editor-field__error">{{ errors.command }}</span>
            <span v-else class="editor-field__hint">网关以子进程方式启动该命令，工作目录由网关配置决定。</span>
          </div>

          <div class="editor-field">
            <label class="editor-field__label" for="mcp-args">参数（每行一个）</label>
            <TextArea
              id="mcp-args"
              v-model="form.argsText"
              :autosize="{ minRows: 3, maxRows: 6 }"
              placeholder="server.js&#10;--port=9100"
            />
          </div>
        </template>

        <template v-else>
          <div class="editor-field">
            <label class="editor-field__label" for="mcp-url">
              服务地址<span class="editor-field__required">*</span>
            </label>
            <Input
              id="mcp-url"
              v-model="form.url"
              placeholder="https://mcp.example.com/mcp"
              :validate-status="errors.url ? 'error' : 'default'"
            />
            <span v-if="errors.url" class="editor-field__error">{{ errors.url }}</span>
            <span v-else class="editor-field__hint">仅支持 http(s)。请确认网关到该地址的网络可达。</span>
          </div>
        </template>

        <div class="editor-field">
          <label class="editor-field__label" for="mcp-env">环境变量白名单（每行一个变量名）</label>
          <TextArea
            id="mcp-env"
            v-model="form.envKeysText"
            :autosize="{ minRows: 2, maxRows: 5 }"
            placeholder="MCP_TOKEN&#10;DATASOURCE_URL"
          />
          <span class="editor-field__hint">
            只填写变量名。变量值从网关进程环境注入，不落库、不回传前端。
          </span>
        </div>

        <div class="mcp-form__grid">
          <div class="editor-row" style="border-bottom: none; padding: 0">
            <div class="editor-row__main">
              <span class="editor-row__title">启用</span>
              <span class="editor-row__desc">停用后不会为任何 Agent 挂载。</span>
            </div>
            <Switch v-model="form.enabled" />
          </div>
          <div class="editor-row" style="border-bottom: none; padding: 0">
            <div class="editor-row__main">
              <span class="editor-row__title">只读</span>
              <span class="editor-row__desc">提示网关不暴露写类工具。</span>
            </div>
            <Switch v-model="form.readOnly" />
          </div>
        </div>

        <div class="toolbar" style="justify-content: flex-end">
          <Button
            v-if="editingId !== null"
            theme="borderless"
            type="tertiary"
            :loading="mcp.testingId === editingId"
            @click="testCurrent"
          >
            测试连接
          </Button>
          <span v-else class="subtle">保存后可测试连接</span>
          <Button theme="borderless" type="tertiary" @click="formVisible = false">取消</Button>
          <Button type="primary" theme="solid" :loading="mcp.saving" @click="submit">
            保存
          </Button>
        </div>
      </div>
    </Modal>

    <Modal
      :visible="pendingDelete !== null"
      title="删除 MCP 服务器"
      :footer="false"
      size="small"
      @cancel="pendingDelete = null"
    >
      <div class="mcp-form">
        <p class="muted">
          删除后该服务器提供的工具会立即从所有 Agent 的工具目录中移除，相关授权配置保留但不再生效。
          确认删除「{{ pendingDelete?.name }}」？
        </p>
        <div class="toolbar" style="justify-content: flex-end">
          <Button theme="borderless" type="tertiary" @click="pendingDelete = null">取消</Button>
          <Button type="danger" theme="solid" :loading="deleting" @click="confirmDelete">删除</Button>
        </div>
      </div>
    </Modal>
  </div>
</template>
