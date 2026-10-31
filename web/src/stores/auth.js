/** 登录态仓库：用户与能力标识来自后端，不在浏览器保存密码或 Key。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api/client'
import { newWindowScope, setWindowScope } from '../api/windowSession'

// 用户资料保存在仓库，窗口编号保存在 sessionStorage，认证凭据保存在对应窗口的 HttpOnly Cookie。
export const useAuth = defineStore('auth', () => {
  const user = ref(null),
    ready = ref(false),
    capabilities = ref({})

  /**
   * 请求 GET /me 刷新登录用户；401 视为未登录，其他错误继续抛出。
   */
  async function refresh() {
    try {
      user.value = await api('/me')
    } catch (e) {
      if (e.status !== 401) throw e
      user.value = null
    }
    ready.value = true
  }

  /**
   * 先读取功能配置状态，再加载当前会话，供首次路由访问初始化使用。
   */
  async function init() {
    capabilities.value = await api('/auth/capabilities')
    await refresh()
  }

  /**
   * 按 register 标记调用注册或登录接口，成功后同步仓库用户及就绪状态。
   */
  async function login(body, register = false) {
    // 每次成功登录使用新作用域，复制窗口后切换账号也不会覆盖原窗口 Cookie。
    const scope = newWindowScope()
    user.value = await api('/auth/' + (register ? 'register' : 'login'), { method: 'POST', body, headers: { 'X-Window-Session': scope } })
    setWindowScope(scope)
    // 登录或切换账号后重新获取本人能力，不能沿用上一个用户的 API 配置标识。
    capabilities.value = await api('/auth/capabilities')
    ready.value = true
  }

  /**
   * 请求后端撤销当前会话，成功后清空前端用户状态。
   */
  async function logout() {
    await api('/auth/logout', { method: 'POST' })
    setWindowScope(newWindowScope())
    user.value = null
    capabilities.value = await api('/auth/capabilities')
  }
  return { user, ready, capabilities, refresh, init, login, logout }
})
