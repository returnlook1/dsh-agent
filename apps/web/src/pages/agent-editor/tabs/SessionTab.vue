<script setup lang="ts">
import type { AgentConfig } from '@agent-studio/shared'
import { InputNumber, Switch } from '@aifuxi/semi-ui-vue'

import { toNumber } from '@/utils/format'

const props = defineProps<{
  draft: AgentConfig
  errors: Record<string, string>
}>()

interface UiToggle {
  key: 'showToolCalls' | 'showReasoning' | 'allowAttachments' | 'showModelSelector'
  title: string
  description: string
  disabled?: boolean
}

const UI_TOGGLES: readonly UiToggle[] = [
  {
    key: 'showToolCalls',
    title: '展示工具调用明细',
    description: '在聊天消息中显示工具名、参数摘要、耗时与结果。关闭后服务端仍完整执行权限检查与审计。',
  },
  {
    key: 'showReasoning',
    title: '展示推理过程',
    description: '仅当模型与 Provider 支持返回推理内容时生效，否则不显示任何占位。',
  },
  {
    key: 'allowAttachments',
    title: '允许附件上传',
    description: '第一版受限运行时未开放文件解析通道，开关保持关闭；打开后聊天页也不会显示上传入口。',
    disabled: true,
  },
  {
    key: 'showModelSelector',
    title: '允许切换模型',
    description: '受限 Agent 的模型由发布版本固定，普通用户不可切换，避免绕过配置校验。',
    disabled: true,
  },
]

function setLimit(
  key: 'maxTurns' | 'maxConcurrentRuns' | 'maxRequestsPerHour',
  fallback: number,
  value: number | string | undefined,
): void {
  props.draft.limits[key] = Math.round(toNumber(value, fallback))
}

function setToggle(key: UiToggle['key'], checked: boolean): void {
  props.draft.ui[key] = checked
}
</script>

<template>
  <section class="editor-section">
    <div class="editor-section__head">
      <h2 class="editor-section__title">会话配置</h2>
      <p class="editor-section__desc">
        运行限制由网关在每次请求前后强制校验；界面开关只影响展示，不影响服务端的权限检查与审计。
      </p>
    </div>

    <div class="editor-grid">
      <div class="editor-field">
        <label class="editor-field__label" for="field-max-turns">maxTurns</label>
        <InputNumber
          id="field-max-turns"
          :model-value="props.draft.limits.maxTurns"
          :min="1"
          :max="200"
          :step="1"
          @change="(value: number | string | undefined) => setLimit('maxTurns', 20, value)"
        />
        <span v-if="props.errors['limits.maxTurns']" class="editor-field__error">
          {{ props.errors['limits.maxTurns'] }}
        </span>
        <span v-else class="editor-field__hint">
          单次用户请求内允许的工具循环轮数（1–200）。超出后运行以 run.limit 结束。
        </span>
      </div>

      <div class="editor-field">
        <label class="editor-field__label" for="field-max-concurrent">maxConcurrentRuns</label>
        <InputNumber
          id="field-max-concurrent"
          :model-value="props.draft.limits.maxConcurrentRuns"
          :min="1"
          :max="8"
          :step="1"
          @change="(value: number | string | undefined) => setLimit('maxConcurrentRuns', 1, value)"
        />
        <span v-if="props.errors['limits.maxConcurrentRuns']" class="editor-field__error">
          {{ props.errors['limits.maxConcurrentRuns'] }}
        </span>
        <span v-else class="editor-field__hint">
          同一用户在同一 Agent 上的并发运行数（1–8），超出会立即返回 rate limit。
        </span>
      </div>

      <div class="editor-field">
        <label class="editor-field__label" for="field-max-requests">maxRequestsPerHour</label>
        <InputNumber
          id="field-max-requests"
          :model-value="props.draft.limits.maxRequestsPerHour"
          :min="1"
          :max="10000"
          :step="10"
          @change="
            (value: number | string | undefined) => setLimit('maxRequestsPerHour', 30, value)
          "
        />
        <span v-if="props.errors['limits.maxRequestsPerHour']" class="editor-field__error">
          {{ props.errors['limits.maxRequestsPerHour'] }}
        </span>
        <span v-else class="editor-field__hint">每用户每 Agent 每小时请求上限（1–10000）。</span>
      </div>
    </div>

    <div class="editor-section__head" style="border-bottom: none; padding-bottom: 0">
      <h3 class="editor-section__title">界面开关</h3>
      <p class="editor-section__desc">影响聊天页的展示密度，不改变运行时能力。</p>
    </div>

    <div>
      <div v-for="toggle in UI_TOGGLES" :key="toggle.key" class="editor-row">
        <div class="editor-row__main">
          <span class="editor-row__title">{{ toggle.title }}</span>
          <span class="editor-row__desc">{{ toggle.description }}</span>
        </div>
        <div class="editor-row__control">
          <Switch
            :model-value="props.draft.ui[toggle.key]"
            :disabled="toggle.disabled === true"
            @change="(checked: boolean) => setToggle(toggle.key, checked)"
          />
        </div>
      </div>
    </div>

    <div class="editor-note">
      <span class="editor-note__icon" aria-hidden="true">提示</span>
      <span>
        聊天页是否显示工具过程由 showToolCalls 决定；即使隐藏，网关仍会记录每一次工具调用的决策、
        参数摘要与耗时，管理员可在审计日志中查询。
      </span>
    </div>
  </section>
</template>
