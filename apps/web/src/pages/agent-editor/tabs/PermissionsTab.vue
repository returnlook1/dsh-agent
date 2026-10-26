<script setup lang="ts">
import type { AgentConfig, NetworkAccess } from '@agent-studio/shared'
import { Banner, Input, Select, Switch, Tag } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

const props = defineProps<{ draft: AgentConfig }>()

interface RestrictedCapability {
  key: 'shell' | 'fileRead' | 'fileWrite' | 'pluginManagement'
  title: string
  description: string
  reason: string
}

/**
 * 与 packages/shared/src/catalog.ts 的 RESTRICTED_BLOCKED_CAPABILITIES 保持一致。
 * 前端只做说明展示，真正的阻断在受限运行时。
 */
const RESTRICTED: readonly RestrictedCapability[] = [
  {
    key: 'shell',
    title: 'Shell / 命令执行',
    description: '允许 Agent 执行任意系统命令。',
    reason: '受限 Agent 不提供任意命令执行，避免绕过工具权限与审计。',
  },
  {
    key: 'fileRead',
    title: '文件读取',
    description: '允许 Agent 读取工作目录内的文件。',
    reason: '业务数据只能通过已授权的业务工具读取，运行时不挂载文件系统。',
  },
  {
    key: 'fileWrite',
    title: '文件写入',
    description: '允许 Agent 修改或创建文件。',
    reason: '文件写入需要独立 OS 沙箱，第一版不提供。',
  },
  {
    key: 'pluginManagement',
    title: '插件管理',
    description: '允许 Agent 通过工具修改自身的 DSH 插件组合。',
    reason: '不允许 Agent 修改自身组合，防止权限面被运行时改变。',
  },
]

const NETWORK_OPTIONS = [
  { value: 'none', label: 'none — 完全禁止出网' },
  { value: 'restricted', label: 'restricted — 仅已配置的 MCP / 业务接口' },
  { value: 'allowlist', label: 'allowlist — 仅网关白名单域名' },
]

const toolSummary = computed(() => {
  let allow = 0
  let ask = 0
  let deny = 0
  for (const value of Object.values(props.draft.capabilities.tools)) {
    if (value === 'allow') allow += 1
    else if (value === 'ask') ask += 1
    else deny += 1
  }
  return { allow, ask, deny, total: allow + ask + deny }
})

function setNetworkAccess(value: unknown): void {
  if (value === 'none' || value === 'restricted' || value === 'allowlist') {
    props.draft.security.networkAccess = value as NetworkAccess
  }
}
</script>

<template>
  <section class="editor-section">
    <div class="editor-section__head">
      <h2 class="editor-section__title">权限管理</h2>
      <p class="editor-section__desc">
        受限运行时不提供系统级能力。这里的开关用于说明当前能力边界，不可开启项固定禁用；真正生效的是工具级授权。
      </p>
    </div>

    <Banner type="info" title="受限运行时固定移除的能力无法在此开启">
      <template #description>
        下列能力已从运行时组合中移除，即使配置为 true 也不会生效。工具能否执行由「工具能力」页的
        allow / ask / deny 与策略快照决定。
      </template>
    </Banner>

    <div>
      <div v-for="item in RESTRICTED" :key="item.key" class="editor-row">
        <div class="editor-row__main">
          <span class="editor-row__title">
            {{ item.title }}
            <Tag type="light" color="grey" size="small">运行时移除</Tag>
          </span>
          <span class="editor-row__desc">{{ item.description }}</span>
          <span class="editor-row__desc">{{ item.reason }}</span>
        </div>
        <div class="editor-row__control">
          <Switch :model-value="false" disabled />
        </div>
      </div>
    </div>

    <div class="editor-field">
      <label class="editor-field__label" for="field-network">出网策略</label>
      <Select
        id="field-network"
        :model-value="props.draft.security.networkAccess"
        :option-list="NETWORK_OPTIONS"
        :show-clear="false"
        @change="setNetworkAccess"
      />
      <span class="editor-field__hint">
        restricted 表示模型只能访问已配置的 MCP 服务器与业务接口；none 会同时禁用 MCP 出网。选择 allowlist
        需要网关侧先维护域名白名单，否则发布时会产生 warning。
      </span>
    </div>

    <div class="editor-field">
      <label class="editor-field__label" for="field-data-scope">数据范围</label>
      <Input id="field-data-scope" v-model="props.draft.security.dataScope" placeholder="user-authorized" />
      <span class="editor-field__hint">
        由业务系统解释的数据范围标识，例如「user-authorized」「site-42」。网关会把它写入策略快照，供业务工具校验。
      </span>
    </div>

    <div class="editor-section__head" style="border-bottom: none; padding-bottom: 0">
      <h3 class="editor-section__title">当前工具授权摘要</h3>
      <p class="editor-section__desc">摘要来自「工具能力」页，修改后立即反映在这里。</p>
    </div>

    <div class="tag-row">
      <Tag type="light" color="green">allow {{ toolSummary.allow }}</Tag>
      <Tag type="light" color="blue">ask {{ toolSummary.ask }}</Tag>
      <Tag type="light" color="red">deny {{ toolSummary.deny }}</Tag>
      <span class="subtle">共 {{ toolSummary.total }} 项显式配置，其余工具按默认拒绝处理。</span>
    </div>

    <table class="behaviour-table">
      <thead>
        <tr>
          <th style="width: 120px">授权动作</th>
          <th>实际行为</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><code>allow</code></td>
          <td class="muted">直接执行并写入审计记录，用户无感知。</td>
        </tr>
        <tr>
          <td><code>ask</code></td>
          <td class="muted">
            挂起并弹出审批弹窗，用户「允许一次」后才执行；超时、拒绝或撤销一律不执行。
          </td>
        </tr>
        <tr>
          <td><code>deny</code></td>
          <td class="muted">不执行，直接返回拒绝结果并写入审计记录。</td>
        </tr>
        <tr>
          <td><code>未列出</code></td>
          <td class="muted">按策略默认动作 deny 处理，等同于禁止。</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
