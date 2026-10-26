import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'

import AppLayout from '@/layouts/AppLayout.vue'
import { useAuthStore } from '@/stores/auth'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    /** 无需登录即可访问。 */
    public?: boolean
    /** 仅管理员可访问。 */
    adminOnly?: boolean
    /** 内容区使用整屏布局（聊天）。 */
    focused?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/pages/login/LoginPage.vue'),
    meta: { title: '登录', public: true },
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      { path: '', redirect: { name: 'agents' } },
      {
        path: 'agents',
        name: 'agents',
        component: () => import('@/pages/agents/AgentsPage.vue'),
        meta: { title: 'Agent 管理' },
      },
      {
        path: 'agents/:id/edit',
        name: 'agent-editor',
        component: () => import('@/pages/agent-editor/AgentEditorPage.vue'),
        meta: { title: 'Agent 编辑器' },
      },
      {
        path: 'chat/:agentId?',
        name: 'chat',
        component: () => import('@/pages/chat/ChatPage.vue'),
        meta: { title: '聊天', focused: true },
      },
      {
        path: 'mcp',
        name: 'mcp',
        component: () => import('@/pages/mcp/McpPage.vue'),
        meta: { title: 'MCP 管理', adminOnly: true },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('@/pages/audit/AuditPage.vue'),
        meta: { title: '审计日志', adminOnly: true },
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: { name: 'agents' } },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

router.beforeEach(async (to) => {
  const auth = useAuthStore()
  await auth.restore()

  if (to.meta.public === true) {
    if (auth.isAuthenticated && to.name === 'login') return { name: 'agents' }
    return true
  }
  if (!auth.isAuthenticated) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } }
  }
  if (to.meta.adminOnly === true && !auth.isAdmin) {
    return { name: 'agents' }
  }
  return true
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = title !== undefined ? `${title} · Agent Studio` : 'Agent Studio'
})
