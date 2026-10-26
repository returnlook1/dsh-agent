<script setup lang="ts">
import type { SkillSummaryDto } from '@agent-studio/shared'
import { Checkbox, Spin, Tag, Tooltip, Typography } from '@aifuxi/semi-ui-vue'
import { computed } from 'vue'

const props = defineProps<{
  modelValue: string[]
  skills: SkillSummaryDto[]
  loading?: boolean
  disabled?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>()

const selectedSet = computed(() => new Set(props.modelValue))

const sourceLabels: Record<SkillSummaryDto['source'], string> = {
  project: '项目',
  custom: '自定义',
  user: '用户',
  bundled: '内置',
}

function toggle(name: string): void {
  if (props.disabled === true) return
  emit(
    'update:modelValue',
    selectedSet.value.has(name)
      ? props.modelValue.filter((item) => item !== name)
      : [...props.modelValue, name],
  )
}
</script>

<template>
  <div class="skill-select">
    <div v-if="loading" class="skill-select__state">
      <Spin size="small" />
      <span>正在加载技能清单…</span>
    </div>
    <p v-else-if="skills.length === 0" class="skill-select__state">
      <Typography.Text type="tertiary" size="small">
        没有可用技能（skills 目录为空，或清单加载失败）。
      </Typography.Text>
    </p>
    <div v-else class="skill-list" role="group" aria-label="选择 Skills">
      <div
        v-for="skill in skills"
        :key="skill.name"
        class="skill-row"
        :class="{ 'is-selected': selectedSet.has(skill.name), 'is-disabled': disabled === true }"
        :title="skill.whenToUse ?? skill.description"
      >
        <Checkbox
          :checked="selectedSet.has(skill.name)"
          :disabled="disabled === true"
          @change="toggle(skill.name)"
        />
        <div class="skill-row__body" @click="toggle(skill.name)">
          <div class="skill-row__title">
            <span class="skill-row__name">{{ skill.name }}</span>
            <Tag size="small" type="light" color="grey">{{ sourceLabels[skill.source] ?? skill.source }}</Tag>
          </div>
          <Tooltip
            v-if="skill.whenToUse"
            :content="skill.whenToUse"
            position="right"
          >
            <span class="skill-row__desc">{{ skill.description }}</span>
          </Tooltip>
          <span v-else class="skill-row__desc">{{ skill.description }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
