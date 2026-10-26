<script setup lang="ts">
import type { AgentConfig, AgentDetail, AgentVersionDto, ConfigWarning } from '@agent-studio/shared'
import { Banner, Button, Popconfirm, Tag } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import EmptyState from '@/components/EmptyState.vue'
import StatusTag from '@/components/StatusTag.vue'
import { formatDateTime } from '@/utils/format'
import { ACTION_BEHAVIOUR } from '@/utils/labels'
import { IconPlay, IconWarning } from '@/ui/icons'

const props = defineProps<{
  draft: AgentConfig
  detail: AgentDetail | null
  versions: AgentVersionDto[]
  lastPublished: AgentVersionDto | null
  publishing: boolean
  dirty: boolean
}>()

defineEmits<{ publish: []; save: [] }>()

interface SimulationRow {
  name: string
  action: 'allow' | 'ask' | 'deny'
  behaviour: string
}

const simulation = computed<SimulationRow[]>(() => {
  const entries = Object.entries(props.draft.capabilities.tools).map(([name, action]) => ({
    name,
    action,
    behaviour: ACTION_BEHAVIOUR[action],
  }))
  const order: Record<'allow' | 'ask' | 'deny', number> = { ask: 0, allow: 1, deny: 2 }
  return entries.sort((a, b) => order[a.action] - order[b.action] || a.name.localeCompare(b.name))
})

const resultWarnings = computed<ConfigWarning[]>(() => props.lastPublished?.warnings ?? [])
const latestWarnings = computed<ConfigWarning[]>(
  () => props.versions[0]?.warnings ?? props.lastPublished?.warnings ?? [],
)
const showResult = computed(() => props.lastPublished !== null)
</script>

<template>
  <section class="editor-section">
    <div class="editor-section__head">
      <h2 class="editor-section__title">测试与发布</h2>
      <p class="editor-section__desc">
        发布会冻结当前配置为不可变快照，并逐项校验配置能否在受限运行时落实。发布后在聊天页验证实际行为。
      </p>
    </div>

    <div class="version-highlight">
      <div class="version-highlight__item">
        <span class="version-highlight__k">草稿版本</span>
        <span class="version-highlight__v">v{{ detail?.version ?? draft.version }}</span>
      </div>
      <div class="version-highlight__item">
        <span class="version-highlight__k">已发布版本</span>
        <span class="version-highlight__v">
          {{ detail?.publishedVersion !== undefined ? `v${detail.publishedVersion}` : '未发布' }}
        </span>
      </div>
      <div class="version-highlight__item">
        <span class="version-highlight__k">当前状态</span>
        <span class="version-highlight__v">
          <StatusTag kind="agent-status" :value="detail?.status ?? draft.status" />
        </span>
      </div>
      <div class="version-highlight__item">
        <span class="version-highlight__k">历史版本</span>
        <span class="version-highlight__v">{{ versions.length }}</span>
      </div>
      <div style="margin-left: auto; display: flex; gap: 8px">
        <Button v-if="dirty" theme="borderless" type="tertiary" @click="$emit('save')">先保存草稿</Button>
        <Popconfirm
          title="确认发布新版本？"
          content="发布后普通用户即可在聊天页选择该版本。"
          ok-text="发布"
          cancel-text="取消"
          @confirm="$emit('publish')"
        >
          <Button type="primary" theme="solid" :loading="publishing">
            <template #icon><IconPlay /></template>
            发布新版本
          </Button>
        </Popconfirm>
      </div>
    </div>

    <Banner v-if="dirty" type="info" title="存在未保存修改">
      <template #description>发布前会自动保存草稿，也可以先单独保存并检查差异。</template>
    </Banner>

    <Banner
      v-if="showResult"
      :type="resultWarnings.length > 0 ? 'warning' : 'success'"
      :title="
        resultWarnings.length > 0
          ? `已发布 v${lastPublished?.version}，${resultWarnings.length} 项配置未能在运行时落实`
          : `已发布 v${lastPublished?.version}，全部配置已在运行时验证`
      "
    >
      <template #description>
        <div v-if="resultWarnings.length > 0" class="warning-list">
          <div v-for="item in resultWarnings" :key="item.field" class="warning-item">
            <span class="warning-item__field">{{ item.field }}</span>
            <span>{{ item.message }}</span>
          </div>
        </div>
        <span v-else class="muted">
          发布时间 {{ formatDateTime(lastPublished?.createdAt) }}，发布人 {{ lastPublished?.createdBy }}。
        </span>
      </template>
    </Banner>

    <div v-else-if="latestWarnings.length > 0" class="editor-note">
      <span class="editor-note__icon"><IconWarning /></span>
      <span>最近一次发布有 {{ latestWarnings.length }} 项配置未落实，详见下方版本历史。</span>
    </div>

    <div class="editor-section__head" style="border-bottom: none; padding-bottom: 0">
      <h3 class="editor-section__title">历史版本</h3>
      <p class="editor-section__desc">版本快照不可修改；如需调整请发布新版本。</p>
    </div>

    <EmptyState
      v-if="versions.length === 0"
      title="尚未发布任何版本"
      description="发布后这里会记录每个版本的配置快照、发布人与运行时校验结果。"
      compact
    />

    <div v-else class="version-table">
      <table class="behaviour-table">
        <thead>
          <tr>
            <th style="width: 90px">版本</th>
            <th style="width: 170px">发布时间</th>
            <th style="width: 140px">发布人</th>
            <th style="width: 120px">运行时验证</th>
            <th>未落实配置</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="version in versions" :key="version.version">
            <td><strong>v{{ version.version }}</strong></td>
            <td class="muted">{{ formatDateTime(version.createdAt) }}</td>
            <td class="muted">{{ version.createdBy || '—' }}</td>
            <td>
              <Tag :type="version.verified ? 'light' : 'light'" :color="version.verified ? 'green' : 'amber'">
                {{ version.verified ? '已验证' : '部分未验证' }}
              </Tag>
            </td>
            <td>
              <span v-if="version.warnings.length === 0" class="subtle">无</span>
              <div v-else class="tag-row">
                <Tag v-for="item in version.warnings" :key="`${version.version}-${item.field}`" type="light" color="amber">
                  {{ item.field }}
                </Tag>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="editor-section__head" style="border-bottom: none; padding-bottom: 0">
      <h3 class="editor-section__title">权限模拟</h3>
      <p class="editor-section__desc">
        按当前草稿的授权推演每次工具调用会发生什么。真正的判定由运行时策略快照执行，这里仅用于核对配置。
      </p>
    </div>

    <EmptyState
      v-if="simulation.length === 0"
      title="尚未授权任何工具"
      description="所有工具都会按默认动作 deny 处理，Agent 只能基于提示词回答。"
      compact
    />

    <div v-else class="version-table">
      <table class="behaviour-table">
        <thead>
          <tr>
            <th style="width: 220px">工具</th>
            <th style="width: 110px">授权</th>
            <th>实际行为</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in simulation" :key="row.name">
            <td><code>{{ row.name }}</code></td>
            <td><StatusTag kind="tool-action" :value="row.action" size="small" /></td>
            <td class="muted">{{ row.behaviour }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="editor-note">
      <span class="editor-note__icon" aria-hidden="true">规则</span>
      <span>
        未在列表中出现的工具按 deny 处理；一次审批只放行一次调用；审批超时（默认 120 秒）即拒绝；
        运行时写入撤销标记后，所有工具调用立即拒绝。
      </span>
    </div>
  </section>
</template>
