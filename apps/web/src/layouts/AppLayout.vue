<script setup lang="ts">
import type { HealthResponse } from '@agent-studio/shared'
import type { NavigationSelectData } from '@aifuxi/semi-ui-vue'
import { Button, Nav, Popconfirm } from '@aifuxi/semi-ui-vue'
import type { Component } from 'vue'
import { computed, h, onMounted, ref } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'

import { systemApi } from '@/services/agent-api'
import { useAuthStore } from '@/stores/auth'
import { IconAgents, IconAudit, IconChat, IconLogout, IconMcp } from '@/ui/icons'

interface MenuEntry {
  key: string
  label: string
  icon: Component
  adminOnly?: boolean
}

const MENU: readonly MenuEntry[] = [
  { key: '/agents', label: 'Agent 管理', icon: IconAgents },
  { key: '/chat', label: '聊天', icon: IconChat },
  { key: '/mcp', label: 'MCP 管理', icon: IconMcp, adminOnly: true },
  { key: '/audit', label: '审计日志', icon: IconAudit, adminOnly: true },
]

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const visibleMenu = computed(() => MENU.filter((entry) => entry.adminOnly !== true || auth.isAdmin))

const navItems = computed(() =>
  visibleMenu.value.map((entry) => ({
    itemKey: entry.key,
    text: entry.label,
    icon: () => h(entry.icon),
  })),
)

const selectedKeys = computed<string[]>(() => {
  const path = route.path
  if (path.startsWith('/agents')) return ['/agents']
  if (path.startsWith('/chat')) return ['/chat']
  if (path.startsWith('/mcp')) return ['/mcp']
  if (path.startsWith('/audit')) return ['/audit']
  return []
})

const pageTitle = computed(() => route.meta.title ?? 'Agent Studio')
const isFocused = computed(() => route.meta.focused === true)

const health = ref<HealthResponse | null>(null)
const healthChecked = ref(false)

const gatewayState = computed<'online' | 'offline'>(() =>
  health.value?.ok === true ? 'online' : 'offline',
)
const gatewayText = computed(() => {
  if (!healthChecked.value) return '正在检查网关状态'
  if (health.value?.ok === true) return `网关在线 · DSH ${health.value.dshVersion}`
  return '网关不可达，操作可能失败'
})

onMounted(() => {
  void (async () => {
    try {
      health.value = await systemApi.health()
    } catch {
      health.value = null
    } finally {
      healthChecked.value = true
    }
  })()
})

function onSelect(data: NavigationSelectData): void {
  const key = data.itemKey
  if (typeof key !== 'string') return
  if (route.path === key) return
  void router.push(key)
}

async function logout(): Promise<void> {
  auth.logout()
  await router.replace({ name: 'login' })
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar" aria-label="主导航">
      <RouterLink to="/agents" class="brand">
        <span class="brand__mark" aria-hidden="true">AS</span>
        <span class="brand__text">
          <strong class="brand__name">Agent Studio</strong>
          <small class="brand__sub">受限智能体平台</small>
        </span>
      </RouterLink>

      <Nav
        class="sidebar-nav"
        mode="vertical"
        :items="navItems"
        :selected-keys="selectedKeys"
        @select="onSelect"
      />

      <div class="sidebar-foot">
        <span
          class="sidebar-foot__dot"
          :class="{ 'sidebar-foot__dot--offline': gatewayState === 'offline' && healthChecked }"
          aria-hidden="true"
        />
        <span class="sidebar-foot__text">{{ gatewayText }}</span>
      </div>
    </aside>

    <div class="app-main">
      <header class="app-topbar">
        <div class="app-topbar__left">
          <h1 class="app-topbar__title">{{ pageTitle }}</h1>
        </div>
        <div class="app-topbar__right">
          <div class="user-chip">
            <span class="user-chip__avatar" aria-hidden="true">{{ auth.initials }}</span>
            <span class="user-chip__text">
              <span class="user-chip__name">{{ auth.displayName }}</span>
              <span class="user-chip__role">{{ auth.roleLabel }}</span>
            </span>
          </div>
          <Popconfirm
            title="确认退出登录？"
            content="退出后需要重新输入账号密码。"
            ok-text="退出"
            cancel-text="取消"
            @confirm="logout"
          >
            <Button theme="borderless" type="tertiary">
              <template #icon><IconLogout /></template>
              退出
            </Button>
          </Popconfirm>
        </div>
      </header>

      <main class="app-content" :class="{ 'app-content--flush': isFocused }">
        <RouterView />
      </main>
    </div>
  </div>
</template>
