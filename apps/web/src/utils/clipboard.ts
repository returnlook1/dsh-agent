/** 复制文本到剪贴板；返回是否成功（失败时由调用方给出可见提示）。 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (window.isSecureContext && typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // 权限被拒绝等情况，回退到 execCommand。
  }

  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch {
    return false
  }
}
