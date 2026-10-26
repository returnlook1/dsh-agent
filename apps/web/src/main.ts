import '@aifuxi/semi-theme-default/index.css'
import '@/styles/global.css'

import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import { router } from '@/router'
import { UNAUTHORIZED_EVENT } from '@/services/http'
import { notifyWarning } from '@/services/feedback'
import { useAuthStore } from '@/stores/auth'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(router)

// 任意接口返回 401 时统一回到登录页，避免页面各自处理。
window.addEventListener(UNAUTHORIZED_EVENT, () => {
  const auth = useAuthStore(pinia)
  if (auth.token === null) return
  auth.logout()
  notifyWarning('登录已失效，请重新登录')
  const current = router.currentRoute.value
  void router.replace({
    name: 'login',
    query: current.fullPath === '/' ? {} : { redirect: current.fullPath },
  })
})

app.config.errorHandler = (error, _instance, info) => {
  // 兜底：任何未捕获的组件异常都给出提示，避免白屏无反馈。
  console.error('[agent-studio] 未捕获的组件异常', info, error)
}

void router.isReady().then(() => {
  app.mount('#app')
})
