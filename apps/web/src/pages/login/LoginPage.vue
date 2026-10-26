<script setup lang="ts">
import { Banner, Button, Input } from '@aifuxi/semi-ui-vue'
import { computed, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import { messageOf } from '@/services/feedback'
import { useAuthStore } from '@/stores/auth'

interface PresetAccount {
  label: string
  username: string
  password: string
}

const PRESET_ACCOUNTS: readonly PresetAccount[] = [
  { label: '管理员', username: 'admin', password: 'admin123' },
  { label: '普通用户', username: 'demo', password: 'demo123' },
]

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const form = reactive({ username: '', password: '' })
const errors = reactive({ username: '', password: '' })
const submitError = ref('')

const submitting = computed(() => auth.loading)

function fillPreset(account: PresetAccount): void {
  form.username = account.username
  form.password = account.password
  errors.username = ''
  errors.password = ''
  submitError.value = ''
}

function validate(): boolean {
  errors.username = form.username.trim().length === 0 ? '请输入用户名' : ''
  if (form.password.length === 0) errors.password = '请输入密码'
  else if (form.password.length < 6) errors.password = '密码至少 6 位'
  else errors.password = ''
  return errors.username === '' && errors.password === ''
}

async function submit(): Promise<void> {
  submitError.value = ''
  if (!validate() || submitting.value) return
  try {
    await auth.login(form.username, form.password)
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : ''
    if (redirect.length > 0 && redirect.startsWith('/')) await router.replace(redirect)
    else await router.replace({ name: 'agents' })
  } catch (error) {
    submitError.value = messageOf(error, '登录失败，请检查账号与密码')
  }
}
</script>

<template>
  <div class="login-page">
    <aside class="login-brand">
      <div class="login-brand__inner">
        <span class="login-brand__mark" aria-hidden="true">AS</span>
        <h1 class="login-brand__title">Agent Studio</h1>
        <p class="login-brand__sub">
          基于 DeepSeek Harness 的受限智能体平台。为每个智能体划定能力边界，并把每一次工具调用留在审计记录里。
        </p>
        <ul class="login-brand__points">
          <li>按 Agent 授权工具，allow / ask / deny 三级策略逐项配置。</li>
          <li>受限运行时移除 shell、文件读写与任意出网能力。</li>
          <li>敏感操作在聊天中实时审批，超时即拒绝。</li>
        </ul>
      </div>
    </aside>

    <main class="login-panel">
      <div class="login-card">
        <div>
          <h2 class="login-card__title">登录控制台</h2>
          <p class="login-card__sub">使用平台账号登录，角色决定可见的菜单与操作范围。</p>
        </div>

        <Banner v-if="submitError" type="danger" :title="submitError" />

        <form class="login-form" @submit.prevent="submit">
          <div class="login-field">
            <label class="login-field__label" for="login-username">用户名</label>
            <Input
              id="login-username"
              v-model="form.username"
              placeholder="请输入用户名"
              autocomplete="username"
              :validate-status="errors.username ? 'error' : 'default'"
              @enter-press="submit"
            />
            <span v-if="errors.username" class="login-field__error">{{ errors.username }}</span>
          </div>

          <div class="login-field">
            <label class="login-field__label" for="login-password">密码</label>
            <Input
              id="login-password"
              v-model="form.password"
              type="password"
              placeholder="请输入密码"
              autocomplete="current-password"
              :validate-status="errors.password ? 'error' : 'default'"
              @enter-press="submit"
            />
            <span v-if="errors.password" class="login-field__error">{{ errors.password }}</span>
          </div>

          <Button
            class="login-submit"
            type="primary"
            theme="solid"
            html-type="submit"
            block
            :loading="submitting"
          >
            登录
          </Button>
        </form>

        <div class="login-accounts">
          <span class="login-accounts__title">预置演示账号</span>
          <div v-for="account in PRESET_ACCOUNTS" :key="account.username" class="login-accounts__row">
            <span class="login-accounts__credential">
              {{ account.username }} / {{ account.password }}
            </span>
            <Button
              size="small"
              theme="borderless"
              type="tertiary"
              @click="fillPreset(account)"
            >
              填入{{ account.label }}
            </Button>
          </div>
        </div>
      </div>
    </main>
  </div>
</template>
