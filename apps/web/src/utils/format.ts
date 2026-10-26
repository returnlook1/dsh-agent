/** 时间 / 数字 / 文本的展示格式化，纯函数，方便多处复用。 */

const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))

export function formatDateTime(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  const date = new Date(value)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function formatClock(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  const date = new Date(value)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatRelative(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  const diff = Date.now() - value
  if (diff < 0) return formatDateTime(value)
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour
  if (diff < minute) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  if (diff < 2 * day) return '昨天'
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`
  return formatDateTime(value)
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  if (value < 1000) return `${Math.round(value)} ms`
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`
}

export function formatCount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return '—'
  if (value < 10_000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…`
}

/** 表单数字输入的统一兜底：空值或非法输入回退到 fallback。 */
export function toNumber(value: number | string | undefined | null, fallback: number): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : fallback
  }
  return fallback
}

export function toOptionalNumber(value: number | string | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (value.trim().length === 0) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 剩余时间（毫秒）→ m:ss，用于审批倒计时。 */
export function formatCountdown(milliseconds: number): string {
  const safe = Math.max(0, milliseconds)
  const totalSeconds = Math.ceil(safe / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${pad(seconds)}`
}
