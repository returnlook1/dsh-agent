import type { RouteRecordRaw } from 'vue-router'
import { createRouter, createWebHistory } from 'vue-router'

import PlaygroundPage from '@/pages/PlaygroundPage.vue'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'playground',
    component: PlaygroundPage,
    meta: { title: 'Agent Playground' },
  },
  {
    path: '/c/:conversationId',
    name: 'conversation',
    component: PlaygroundPage,
    meta: { title: 'Agent Playground' },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.afterEach((to) => {
  document.title = typeof to.meta.title === 'string' ? to.meta.title : 'Agent Playground'
})
