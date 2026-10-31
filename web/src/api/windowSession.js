/** 窗口编号保存在 sessionStorage；不保存密码、API Key 或认证令牌。 */
const key = 'mujian.windowSession'
let memoryScope = ''

export function newWindowScope() {
  return crypto.randomUUID().replaceAll('-', '')
}

export function setWindowScope(scope) {
  memoryScope = scope
  try {
    sessionStorage.setItem(key, scope)
  } catch {
    /* 禁用存储时仅在当前页面保留。 */
  }
}

export function getWindowScope() {
  try {
    const stored = sessionStorage.getItem(key)
    if (/^[a-f0-9]{32}$/.test(stored || '')) return stored
  } catch {
    /* 保留当前页面的内存作用域。 */
  }
  if (!memoryScope) setWindowScope(newWindowScope())
  return memoryScope
}

export const windowSessionHeaders = () => ({ 'X-Window-Session': getWindowScope() })
