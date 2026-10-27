<script setup lang="ts">
import type { McpTransport, UpsertMcpServerRequest } from '@agent-studio/shared'
import { Button, Input, Modal, Popconfirm, Select, Tag, TextArea } from '@aifuxi/semi-ui-vue'
import { computed, ref } from 'vue'

import { useConfigStore } from '@/stores/config'
import { useUiStore } from '@/stores/ui'

const config = useConfigStore()
const ui = useUiStore()

/* ------------------------------------------------------------------ 技能 */

const skillVisible = ref(false)
const skillSaving = ref(false)
const skillError = ref<string | null>(null)
const skillForm = ref({ name: '', description: '', whenToUse: '', body: '' })

function openCreateSkill(): void {
  skillForm.value = { name: '', description: '', whenToUse: '', body: '' }
  skillError.value = null
  skillVisible.value = true
}

async function submitSkill(): Promise<void> {
  skillError.value = null
  const form = skillForm.value
  if (form.name.trim().length === 0) {
    skillError.value = '请填写技能名（小写字母、数字、- _ .）'
    return
  }
  if (form.description.trim().length === 0) {
    skillError.value = '请填写描述（会进入模型可见的技能说明）'
    return
  }
  skillSaving.value = true
  const created = await config.createSkill({
    name: form.name.trim(),
    description: form.description.trim(),
    ...(form.whenToUse.trim().length === 0 ? {} : { whenToUse: form.whenToUse.trim() }),
    ...(form.body.trim().length === 0 ? {} : { body: form.body }),
  })
  skillSaving.value = false
  if (created === null) {
    skillError.value = config.sourcesError ?? '新建技能失败'
    return
  }
  skillVisible.value = false
  ui.notifySuccess(`技能已创建：${created.name}`)
}

/* ------------------------------------------------------------------- MCP */

const mcpVisible = ref(false)
const mcpSaving = ref(false)
const mcpError = ref<string | null>(null)
const mcpForm = ref({
  id: '',
  name: '',
  description: '',
  transport: 'stdio' as McpTransport,
  command: '',
  args: '',
  url: '',
  env: '',
  headers: '',
  toolCallTimeoutMs: 30_000,
  enabled: true,
})

function openCreateMcp(): void {
  mcpForm.value = {
    id: '',
    name: '',
    description: '',
    transport: 'stdio',
    command: '',
    args: '',
    url: '',
    env: '',
    headers: '',
    toolCallTimeoutMs: 30_000,
    enabled: true,
  }
  mcpError.value = null
  mcpVisible.value = true
}

/** `KEY=value` 行 → record；值里的 `${ENV}` 原样保留（服务端只在运行时求值）。 */
function parsePairs(lines: string): Record<string, string> {
  const record: Record<string, string> = {}
  for (const line of lines.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    record[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return record
}

async function submitMcp(): Promise<void> {
  mcpError.value = null
  const form = mcpForm.value
  const id = form.id.trim()
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
    mcpError.value = 'id 只允许字母、数字、- 和 _，最长 32 字符'
    return
  }
  if (form.name.trim().length === 0) {
    mcpError.value = '请填写显示名'
    return
  }
  if (form.transport === 'stdio' && form.command.trim().length === 0) {
    mcpError.value = 'stdio 需要 command（例如 node）'
    return
  }
  if (form.transport === 'streamable-http' && form.url.trim().length === 0) {
    mcpError.value = 'streamable-http 需要 url'
    return
  }

  const payload = {
    name: form.name.trim(),
    ...(form.description.trim().length === 0 ? {} : { description: form.description.trim() }),
    transport: form.transport,
    ...(form.transport === 'stdio' ? { command: form.command.trim() } : { url: form.url.trim() }),
    args:
      form.transport === 'stdio'
        ? form.args
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
        : [],
    env: form.transport === 'stdio' ? parsePairs(form.env) : {},
    headers: form.transport === 'streamable-http' ? parsePairs(form.headers) : {},
    toolCallTimeoutMs: form.toolCallTimeoutMs,
    failOnStartup: false,
    enabled: form.enabled,
  } satisfies UpsertMcpServerRequest

  mcpSaving.value = true
  const ok = await config.saveMcpServer(id, payload)
  mcpSaving.value = false
  if (!ok) {
    mcpError.value = config.sourcesError ?? '保存失败'
    return
  }
  mcpVisible.value = false
  ui.notifySuccess(`MCP 服务器已保存：${id}`)
}

async function removeMcp(id: string): Promise<void> {
  const ok = await config.removeMcpServer(id)
  if (ok) ui.notifySuccess(`已删除 MCP 服务器：${id}`)
  else ui.notifyError(config.sourcesError ?? '删除失败')
}

/* --------------------------------------------------------------- 本地动作 */

async function reveal(target: 'skills' | 'mcp'): Promise<void> {
  const ok = await config.revealCapability(target)
  if (ok) ui.notifyInfo(target === 'skills' ? '已在资源管理器打开技能目录' : '已在资源管理器打开 MCP 配置')
  else ui.notifyError(config.sourcesError ?? '打开失败')
}

const localServers = computed(() =>
  config.mcpServers.filter((server) => server.source === 'config'),
)

const sources = computed(() => config.capabilitySources)
const canReveal = computed(() => sources.value?.actions.reveal === true)
</script>

<template>
  <section class="source-panel">
    <header class="source-panel__head">
      <div>
        <p class="panel__eyebrow">capability sources</p>
        <p class="source-panel__title">能力来源</p>
      </div>
      <Button size="small" theme="borderless" :loading="config.sourcesLoading" @click="config.loadCapabilitySources()">
        刷新
      </Button>
    </header>

    <p v-if="config.sourcesError" class="field__hint field__hint--danger">{{ config.sourcesError }}</p>

    <!-- Skills -->
    <div class="source-block">
      <div class="source-block__head">
        <span class="source-block__label">Skills · {{ sources?.skills.total ?? 0 }}</span>
        <div class="source-block__actions">
          <Button size="small" theme="borderless" @click="openCreateSkill">新建技能</Button>
          <Button
            size="small"
            theme="borderless"
            :disabled="!canReveal"
            title="在资源管理器打开可写技能目录"
            @click="reveal('skills')"
          >
            打开目录
          </Button>
        </div>
      </div>
      <div v-if="(sources?.skills.roots ?? []).length === 0" class="field__hint">尚未配置技能目录</div>
      <ul v-else class="source-list">
        <li v-for="root in sources?.skills.roots ?? []" :key="root.path" class="source-row">
          <div class="source-row__main">
            <span class="source-row__name">{{ root.label }}</span>
            <span class="source-row__count">{{ root.count }}</span>
            <Tag v-if="root.writable" size="small" type="light" color="green">可写</Tag>
            <Tag v-else size="small" type="light" color="grey">只读</Tag>
          </div>
          <code class="source-row__path" :title="root.path">{{ root.path }}</code>
        </li>
      </ul>
      <p class="field__hint">
        新建技能会写入 {{ sources?.skills.writableRoot ?? '第一个可写目录' }}；也可以直接放一个含
        <code>SKILL.md</code> 的目录。
      </p>
    </div>

    <!-- MCP -->
    <div class="source-block">
      <div class="source-block__head">
        <span class="source-block__label">MCP · {{ sources?.mcp.localCount ?? 0 }} 项</span>
        <div class="source-block__actions">
          <Button size="small" theme="borderless" @click="openCreateMcp">新增 MCP</Button>
          <Button
            size="small"
            theme="borderless"
            :disabled="!canReveal"
            title="用默认编辑器打开 config/mcp-servers.json"
            @click="reveal('mcp')"
          >
            打开配置
          </Button>
        </div>
      </div>
      <code class="source-row__path" :title="sources?.mcp.configPath">{{ sources?.mcp.configPath }}</code>
      <p v-if="sources?.mcp.dshSource" class="field__hint">
        另有来自 DSH Profile 的只读条目：{{ sources?.mcp.dshSource }}
      </p>
      <ul v-if="localServers.length > 0" class="source-list">
        <li v-for="server in localServers" :key="server.id" class="source-row">
          <div class="source-row__main">
            <span class="source-row__name">{{ server.name }}</span>
            <span class="source-row__count">{{ server.transport }}</span>
            <Tag v-if="!server.enabled" size="small" type="light" color="orange">已停用</Tag>
          </div>
          <div class="source-row__side">
            <code class="source-row__path">{{ server.id }}</code>
            <Popconfirm
              title="删除该 MCP 服务器？"
              content="会从 config/mcp-servers.json 中移除；不影响 DSH Profile 导入的条目。"
              ok-text="删除"
              cancel-text="取消"
              ok-type="danger"
              @confirm="removeMcp(server.id)"
            >
              <Button size="small" type="danger" theme="borderless">删除</Button>
            </Popconfirm>
          </div>
        </li>
      </ul>
      <p class="field__hint">
        修改现有条目可直接「打开配置」编辑 JSON（保存后自动生效，无需重启）；凭据写
        <code>${ENV_NAME}</code> 引用，服务不会把真实值写进文件。
      </p>
    </div>

    <!-- 新建技能 -->
    <Modal
      :visible="skillVisible"
      title="新建技能"
      ok-text="创建"
      cancel-text="取消"
      :confirm-loading="skillSaving"
      @ok="submitSkill"
      @cancel="skillVisible = false"
    >
      <div class="dialog-form">
        <label class="dialog-form__label" for="skill-name">技能名</label>
        <Input id="skill-name" v-model="skillForm.name" placeholder="water-quality" />
        <label class="dialog-form__label" for="skill-desc">描述（模型可见）</label>
        <Input id="skill-desc" v-model="skillForm.description" placeholder="一句话说明这个技能做什么" />
        <label class="dialog-form__label" for="skill-when">何时使用（可选）</label>
        <Input id="skill-when" v-model="skillForm.whenToUse" placeholder="例如：需要判定水质类别时" />
        <label class="dialog-form__label" for="skill-body">正文（可选，Markdown）</label>
        <TextArea
          id="skill-body"
          v-model="skillForm.body"
          :autosize="{ minRows: 4, maxRows: 10 }"
          placeholder="留空会生成模板：标题 / 何时使用 / 步骤"
        />
        <p v-if="skillError" class="field__hint field__hint--danger">{{ skillError }}</p>
      </div>
    </Modal>

    <!-- 新增 MCP -->
    <Modal
      :visible="mcpVisible"
      title="新增 MCP 服务器"
      ok-text="保存"
      cancel-text="取消"
      :confirm-loading="mcpSaving"
      @ok="submitMcp"
      @cancel="mcpVisible = false"
    >
      <div class="dialog-form">
        <label class="dialog-form__label" for="mcp-id">id（唯一，写进工具名前缀）</label>
        <Input id="mcp-id" v-model="mcpForm.id" placeholder="water-service" />
        <label class="dialog-form__label" for="mcp-name">显示名</label>
        <Input id="mcp-name" v-model="mcpForm.name" placeholder="水质服务" />
        <label class="dialog-form__label" for="mcp-desc">描述（可选）</label>
        <Input id="mcp-desc" v-model="mcpForm.description" placeholder="这个服务器提供什么工具" />
        <label class="dialog-form__label">传输</label>
        <Select v-model="mcpForm.transport" style="width: 100%">
          <Select.Option value="stdio">stdio（本地进程）</Select.Option>
          <Select.Option value="streamable-http">streamable-http（远程端点）</Select.Option>
        </Select>
        <template v-if="mcpForm.transport === 'stdio'">
          <label class="dialog-form__label" for="mcp-command">command</label>
          <Input id="mcp-command" v-model="mcpForm.command" placeholder="node" />
          <label class="dialog-form__label" for="mcp-args">args（一行一个）</label>
          <TextArea id="mcp-args" v-model="mcpForm.args" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="./server.mjs" />
          <label class="dialog-form__label" for="mcp-env">env（KEY=value，一行一个）</label>
          <TextArea id="mcp-env" v-model="mcpForm.env" :autosize="{ minRows: 2, maxRows: 6 }" placeholder="WATER_TOKEN=${WATER_TOKEN}" />
        </template>
        <template v-else>
          <label class="dialog-form__label" for="mcp-url">url</label>
          <Input id="mcp-url" v-model="mcpForm.url" placeholder="https://example.com/mcp" />
          <label class="dialog-form__label" for="mcp-headers">headers（KEY=value，一行一个）</label>
          <TextArea
            id="mcp-headers"
            v-model="mcpForm.headers"
            :autosize="{ minRows: 2, maxRows: 6 }"
            placeholder="Authorization=Bearer ${MCP_TOKEN}"
          />
        </template>
        <label class="dialog-form__label" for="mcp-timeout">工具超时（毫秒）</label>
        <Input
          id="mcp-timeout"
          :model-value="String(mcpForm.toolCallTimeoutMs)"
          @update:model-value="mcpForm.toolCallTimeoutMs = Number($event) || 30000"
        />
        <p class="field__hint">
          凭据只写 <code>${ENV_NAME}</code> 引用；真实值从服务进程环境读取，不会落盘。
        </p>
        <p v-if="mcpError" class="field__hint field__hint--danger">{{ mcpError }}</p>
      </div>
    </Modal>
  </section>
</template>
