/**
 * 统一的用户反馈入口：把任意异常翻译成中文提示并交给 Semi Toast。
 * 页面只调用这里，不各自拼错误文案，保证提示口径一致。
 */
import { Toast } from '@aifuxi/semi-ui-vue'

import { HttpError } from './http'

export function messageOf(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof HttpError) {
    if (error.code === 'ABORTED') return '请求已取消'
    return error.message || fallback
  }
  if (error instanceof Error && error.message.length > 0) return error.message
  return fallback
}

export function notifyError(error: unknown, fallback?: string): string {
  const message = messageOf(error, fallback)
  Toast.error({ content: message, duration: 5000 })
  return message
}

export function notifySuccess(content: string): void {
  Toast.success({ content, duration: 3000 })
}

export function notifyWarning(content: string): void {
  Toast.warning({ content, duration: 4000 })
}

export function notifyInfo(content: string): void {
  Toast.info({ content, duration: 3000 })
}
