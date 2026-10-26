<script setup lang="ts">
import type { AgentConfig, ConfigWarning } from '@agent-studio/shared'
import { Banner, Input, InputNumber, Select, Slider } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

import { toOptionalNumber } from '@/utils/format'

const props = defineProps<{
  draft: AgentConfig
  errors: Record<string, string>
  warnings: ConfigWarning[]
}>()

const REASONING_OPTIONS = [
  { value: 'low', label: 'low — 低强度，响应更快' },
  { value: 'medium', label: 'medium — 平衡' },
  { value: 'high', label: 'high — 更充分推理，耗时更长' },
]

const ENFORCEMENT = [
  {
    field: 'provider / modelId',
    status: '强校验',
    mechanism: '运行时按名称查找 Provider 与模型，名称不存在时发布失败。',
  },
  {
    field: 'maxOutputTokens',
    status: '已落实',
    mechanism: '通过 SDK 请求的 maxTokens 参数下发，限制单次根 Agent 请求的输出长度。',
  },
  {
    field: 'temperature',
    status: '受限',
    mechanism: 'SDK initialize 不携带采样参数，发布时会生成 warning，实际取值由 Provider 默认值决定。',
  },
  {
    field: 'reasoningEffort',
    status: '依赖 Provider',
    mechanism: '由 Provider 适配器映射；适配器不支持时发布记录 warning，不会静默忽略。',
  },
]

const modelWarnings = computed(() => props.warnings.filter((item) => item.field.startsWith('model.')))
const otherWarnings = computed(() => props.warnings.filter((item) => !item.field.startsWith('model.')))

function setTemperature(value: number | string | undefined | number[]): void {
  if (Array.isArray(value)) return
  const parsed = toOptionalNumber(value)
  if (parsed === undefined) delete props.draft.model.temperature
  else props.draft.model.temperature = parsed
}

function setMaxOutputTokens(value: number | string | undefined): void {
  const parsed = toOptionalNumber(value)
  if (parsed === undefined) delete props.draft.model.maxOutputTokens
  else props.draft.model.maxOutputTokens = Math.round(parsed)
}

function setReasoning(value: unknown): void {
  if (typeof value === 'string' && value.length > 0) props.draft.model.reasoningEffort = value
  else delete props.draft.model.reasoningEffort
}

const temperatureValue = computed(() => props.draft.model.temperature ?? 0.7)
</script>

<template>
  <section class="editor-section">
    <div class="editor-section__head">
      <h2 class="editor-section__title">模型设置</h2>
      <p class="editor-section__desc">
        参数最终能否生效取决于运行时实现。发布时网关会重新校验，并返回未能在运行时落实的配置项。
      </p>
    </div>

    <div class="editor-grid">
      <div class="editor-field">
        <label class="editor-field__label" for="field-provider">
          Provider<span class="editor-field__required">*</span>
        </label>
        <Input
          id="field-provider"
          v-model="props.draft.model.provider"
          placeholder="deepseek-official"
          :validate-status="props.errors['model.provider'] ? 'error' : 'default'"
        />
        <span v-if="props.errors['model.provider']" class="editor-field__error">
          {{ props.errors['model.provider'] }}
        </span>
        <span v-else class="editor-field__hint">必须与 DSH 实际注册的 Provider 名称一致。</span>
      </div>

      <div class="editor-field">
        <label class="editor-field__label" for="field-model-id">
          模型 ID<span class="editor-field__required">*</span>
        </label>
        <Input
          id="field-model-id"
          v-model="props.draft.model.modelId"
          placeholder="deepseek-v4-flash"
          :validate-status="props.errors['model.modelId'] ? 'error' : 'default'"
        />
        <span v-if="props.errors['model.modelId']" class="editor-field__error">
          {{ props.errors['model.modelId'] }}
        </span>
        <span v-else class="editor-field__hint">以 Provider 实际返回的模型名称为准。</span>
      </div>
    </div>

    <div class="editor-field">
      <label class="editor-field__label" for="field-temperature">temperature</label>
      <div class="editor-row__control" style="gap: 16px; width: 100%">
        <Slider
          :model-value="temperatureValue"
          :min="0"
          :max="2"
          :step="0.1"
          :show-boundary="true"
          style="flex: 1 1 auto"
          @change="setTemperature"
        />
        <InputNumber
          id="field-temperature"
          :model-value="props.draft.model.temperature"
          :min="0"
          :max="2"
          :step="0.1"
          :precision="1"
          placeholder="默认"
          style="width: 110px"
          @change="setTemperature"
        />
      </div>
      <span v-if="props.errors['model.temperature']" class="editor-field__error">
        {{ props.errors['model.temperature'] }}
      </span>
      <span v-else class="editor-field__hint">留空表示使用 Provider 默认值。当前 SDK 无法下发该参数。</span>
    </div>

    <div class="editor-grid">
      <div class="editor-field">
        <label class="editor-field__label" for="field-max-output">最大输出 token</label>
        <InputNumber
          id="field-max-output"
          :model-value="props.draft.model.maxOutputTokens"
          :min="1"
          :max="200000"
          :step="1024"
          placeholder="使用 Provider 默认上限"
          @change="setMaxOutputTokens"
        />
        <span v-if="props.errors['model.maxOutputTokens']" class="editor-field__error">
          {{ props.errors['model.maxOutputTokens'] }}
        </span>
        <span v-else class="editor-field__hint">限制单次请求的输出长度，过小会导致回答被截断。</span>
      </div>

      <div class="editor-field">
        <label class="editor-field__label" for="field-reasoning">推理强度</label>
        <Select
          id="field-reasoning"
          :model-value="props.draft.model.reasoningEffort ?? ''"
          :option-list="REASONING_OPTIONS"
          :show-clear="true"
          placeholder="未设置"
          @change="setReasoning"
        />
        <span class="editor-field__hint">仅对支持该参数的 Provider 生效，其余情况在发布时给出 warning。</span>
      </div>
    </div>

    <div class="editor-section__head" style="border-bottom: none; padding-bottom: 0">
      <h3 class="editor-section__title">运行时落实情况</h3>
      <p class="editor-section__desc">下表说明每个参数在受限运行时里由谁负责落实。</p>
    </div>

    <table class="behaviour-table">
      <thead>
        <tr>
          <th style="width: 180px">配置项</th>
          <th style="width: 110px">落实状态</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in ENFORCEMENT" :key="item.field">
          <td><code>{{ item.field }}</code></td>
          <td>{{ item.status }}</td>
          <td class="muted">{{ item.mechanism }}</td>
        </tr>
      </tbody>
    </table>

    <Banner
      v-if="modelWarnings.length > 0"
      type="warning"
      title="以下模型参数未能在运行时落实"
    >
      <template #description>
        <ul class="warning-list">
          <li v-for="item in modelWarnings" :key="item.field" class="warning-item">
            <span class="warning-item__field">{{ item.field }}</span>
            <span>{{ item.message }}</span>
          </li>
        </ul>
      </template>
    </Banner>
    <div v-else-if="props.warnings.length === 0" class="editor-note">
      <span class="editor-note__icon" aria-hidden="true">提示</span>
      <span>尚未发布，或最近一次发布没有产生 warning。发布后这里会列出运行时未能落实的配置项。</span>
    </div>

    <div v-if="otherWarnings.length > 0" class="editor-note">
      <span class="editor-note__icon" aria-hidden="true">提示</span>
      <span>其他页签还有 {{ otherWarnings.length }} 项未落实配置，可在「测试与发布」页查看完整列表。</span>
    </div>
  </section>
</template>
