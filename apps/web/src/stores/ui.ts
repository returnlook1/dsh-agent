/**
 * 全局 UI 状态：服务健康、Toast 提示。
 *
 * 健康检查失败只影响右上角状态点，不阻塞页面使用（对应需求的"不可用时置灰"）。
 */
import { Toast } from '@aifuxi/semi-ui-vue'
import { defineStore } from 'pinia'
import { ref } from 'vue'

import { describeApiError, getHealth, type ServiceHealth } from '@/services/agent-api'

export type HealthState = 'checking' | 'online' | 'offline'

export const useUiStore = defineStore('ui', () => {
  const health = ref<HealthState>('checking')
  const healthInfo = ref<ServiceHealth | null>(null)

  let pollTimer: number | null = null

  async function checkHealth(): Promise<void> {
    try {
      const info = await getHealth()
      healthInfo.value = info
      health.value = info.ok ? 'online' : 'offline'
    } catch {
      healthInfo.value = null
      health.value = 'offline'
    }
  }

  function startHealthPolling(intervalMs = 20_000): void {
    stopHealthPolling()
    void checkHealth()
    pollTimer = window.setInterval(() => {
      void checkHealth()
    }, intervalMs)
  }

  function stopHealthPolling(): void {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer)
      pollTimer = null
    }
  }

  function notifySuccess(message: string): void {
    Toast.success(message)
  }

  function notifyError(error: unknown): void {
    Toast.error(describeApiError(error))
  }

  function notifyInfo(message: string): void {
    Toast.info(message)
  }

  return {
    health,
    healthInfo,
    checkHealth,
    startHealthPolling,
    stopHealthPolling,
    notifySuccess,
    notifyError,
    notifyInfo,
  }
})
