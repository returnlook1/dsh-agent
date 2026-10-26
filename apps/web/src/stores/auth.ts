/** 登录态：token + 用户资料，落在 localStorage，刷新后由 /auth/me 复核。 */
import type { Role, UserDto } from '@agent-studio/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { authApi } from '@/services/agent-api'
import {
  EXPIRES_STORAGE_KEY,
  HttpError,
  TOKEN_STORAGE_KEY,
  USER_STORAGE_KEY,
} from '@/services/http'

function readJson<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

function readNumber(key: string): number | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

function writeStorage(token: string | null, user: UserDto | null, expiresAt: number | null): void {
  try {
    if (token === null || user === null) {
      window.localStorage.removeItem(TOKEN_STORAGE_KEY)
      window.localStorage.removeItem(USER_STORAGE_KEY)
      window.localStorage.removeItem(EXPIRES_STORAGE_KEY)
      return
    }
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user))
    if (expiresAt !== null) window.localStorage.setItem(EXPIRES_STORAGE_KEY, String(expiresAt))
    else window.localStorage.removeItem(EXPIRES_STORAGE_KEY)
  } catch {
    // 隐私模式下 localStorage 不可写：会话内仍然可用。
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(
    (() => {
      try {
        return window.localStorage.getItem(TOKEN_STORAGE_KEY)
      } catch {
        return null
      }
    })(),
  )
  const user = ref<UserDto | null>(readJson<UserDto>(USER_STORAGE_KEY))
  const expiresAt = ref<number | null>(readNumber(EXPIRES_STORAGE_KEY))
  const loading = ref(false)
  const ready = ref(false)

  const isAuthenticated = computed(() => {
    if (token.value === null) return false
    if (expiresAt.value !== null && expiresAt.value <= Date.now()) return false
    return true
  })
  const role = computed<Role>(() => user.value?.role ?? 'user')
  const isAdmin = computed(() => role.value === 'admin')
  const displayName = computed(() => user.value?.displayName || user.value?.username || '未登录')
  const roleLabel = computed(() => (role.value === 'admin' ? '管理员' : '普通用户'))
  const initials = computed(() => displayName.value.slice(0, 1).toUpperCase())

  async function login(username: string, password: string): Promise<UserDto> {
    loading.value = true
    try {
      const response = await authApi.login({ username: username.trim(), password })
      token.value = response.token
      user.value = response.user
      expiresAt.value = response.expiresAt
      writeStorage(response.token, response.user, response.expiresAt)
      ready.value = true
      return response.user
    } finally {
      loading.value = false
    }
  }

  function logout(): void {
    token.value = null
    user.value = null
    expiresAt.value = null
    ready.value = true
    writeStorage(null, null, null)
  }

  /**
   * 复核登录态。网络不可用时保留本地缓存的用户资料（客厅可见但写操作会失败），
   * 只有明确 401 才登出，避免网关重启把用户踢下线。
   */
  async function restore(): Promise<void> {
    if (ready.value) return
    if (token.value === null) {
      ready.value = true
      return
    }
    if (expiresAt.value !== null && expiresAt.value <= Date.now()) {
      logout()
      return
    }
    try {
      const me = await authApi.me()
      user.value = me
      writeStorage(token.value, me, expiresAt.value)
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        logout()
        return
      }
      // 网络错误：保留缓存用户，交由各页面的错误提示处理。
    }
    ready.value = true
  }

  return {
    token,
    user,
    expiresAt,
    loading,
    ready,
    isAuthenticated,
    isAdmin,
    role,
    roleLabel,
    displayName,
    initials,
    login,
    logout,
    restore,
  }
})
