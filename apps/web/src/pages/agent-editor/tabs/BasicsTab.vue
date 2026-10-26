<script setup lang="ts">
import type { AgentConfig } from '@agent-studio/shared'
import { Input, TextArea } from '@aifuxi/semi-ui-vue'

import StatusTag from '@/components/StatusTag.vue'

const props = defineProps<{
  draft: AgentConfig
  errors: Record<string, string>
}>()
</script>

<template>
  <section class="editor-section">
    <div class="editor-section__head">
      <h2 class="editor-section__title">基本信息</h2>
      <p class="editor-section__desc">
        名称与描述会出现在 Agent 列表和聊天页；系统提示词在运行时注入受限 Profile，不会混入用户消息。
      </p>
    </div>

    <div class="editor-grid">
      <div class="editor-field">
        <label class="editor-field__label" for="field-name">
          名称<span class="editor-field__required">*</span>
        </label>
        <Input
          id="field-name"
          v-model="props.draft.name"
          :max-length="80"
          placeholder="例如：水环境智能助手"
          :validate-status="props.errors.name ? 'error' : 'default'"
        />
        <span v-if="props.errors.name" class="editor-field__error">{{ props.errors.name }}</span>
        <span v-else class="editor-field__hint">建议使用业务对象命名，长度不超过 80 个字符。</span>
      </div>

      <div class="editor-field">
        <label class="editor-field__label" for="field-description">描述</label>
        <Input
          id="field-description"
          v-model="props.draft.description"
          :max-length="400"
          placeholder="一句话说明能力范围"
          :validate-status="props.errors.description ? 'error' : 'default'"
        />
        <span v-if="props.errors.description" class="editor-field__error">
          {{ props.errors.description }}
        </span>
        <span v-else class="editor-field__hint">展示在列表卡片与聊天页副标题，最多 400 个字符。</span>
      </div>
    </div>

    <div class="editor-field">
      <label class="editor-field__label" for="field-system">系统提示词</label>
      <TextArea
        id="field-system"
        v-model="props.draft.prompt.system"
        :autosize="{ minRows: 8, maxRows: 18 }"
        :max-length="8000"
        placeholder="描述角色、数据口径与回答约束；不要在这里写权限规则，权限永远来自策略快照。"
      />
      <span class="editor-field__hint">
        提示词只影响模型表达，不构成授权。工具能否执行由「工具能力」页的 allow / ask / deny 与运行时的策略快照决定。
      </span>
    </div>

    <div class="editor-field">
      <label class="editor-field__label" for="field-welcome">欢迎语</label>
      <TextArea
        id="field-welcome"
        v-model="props.draft.prompt.welcome"
        :autosize="{ minRows: 2, maxRows: 5 }"
        :max-length="400"
        placeholder="聊天页在空会话时展示的引导语"
      />
      <span class="editor-field__hint">仅前端展示，不会发送给模型。</span>
    </div>

    <div class="editor-note">
      <span class="editor-note__icon" aria-hidden="true">只读</span>
      <span>
        标识 <strong>{{ props.draft.id || '发布后由服务端生成' }}</strong>，当前状态
        <StatusTag kind="agent-status" :value="props.draft.status" size="small" />，草稿版本 v{{ props.draft.version }}。
        状态与版本由发布流程维护，不在此处编辑。
      </span>
    </div>
  </section>
</template>
