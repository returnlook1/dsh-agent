import '@aifuxi/semi-theme-default/index.css'
import '@/styles/global.css'

import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import { router } from '@/router'

const app = createApp(App)
app.use(createPinia())
app.use(router)

app.config.errorHandler = (error, _instance, info) => {
  // 兜底：任何未捕获的组件异常都留在控制台，避免静默白屏。
  console.error('[agent-playground] 未捕获的组件异常', info, error)
}

void router.isReady().then(() => {
  app.mount('#app')
})
