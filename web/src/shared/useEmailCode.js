/** 邮箱验证码发送状态：按邮箱和用途分别计时，切换表单不会误用另一用途的验证码。 */
import { computed, onScopeDispose, ref, toValue } from 'vue'
import { api } from '../api/client'

export const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())

export function useEmailCode(email, purpose) {
  const sending = ref(false),
    now = ref(Date.now()),
    deadlines = ref({})
  const key = computed(() => `${String(toValue(email)).trim().toLowerCase()}:${toValue(purpose)}`)
  const countdown = computed(() => Math.max(0, Math.ceil(((deadlines.value[key.value] || 0) - now.value) / 1000)))
  let timer
  onScopeDispose(() => clearInterval(timer))

  /** 只在服务器接受发送后启动倒计时；发送中的目标邮箱及用途使用请求快照。 */
  async function send() {
    if (sending.value || countdown.value) return false
    const recipient = String(toValue(email)).trim().toLowerCase(),
      usage = toValue(purpose)
    if (!validEmail(recipient)) throw new Error('请先填写有效的邮箱地址')
    sending.value = true
    try {
      const result = await api('/auth/email-code', { method: 'POST', body: { email: recipient, purpose: usage } })
      now.value = Date.now()
      deadlines.value[`${recipient}:${usage}`] = now.value + (result.retryAfter || 60) * 1000
      clearInterval(timer)
      timer = setInterval(() => {
        now.value = Date.now()
        if (Object.values(deadlines.value).every((deadline) => deadline <= now.value)) clearInterval(timer)
      }, 1000)
      return true
    } finally {
      sending.value = false
    }
  }

  return { sending, countdown, send }
}
