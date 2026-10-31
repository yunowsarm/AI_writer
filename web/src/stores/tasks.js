/** 后台任务仓库：统一轮询任务状态，页面离开不会取消服务端任务。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api/client'

export const useTasks = defineStore('tasks', () => {
  const items = ref([]),
    revision = ref(0),
    error = ref('')
  let pending = null,
    epoch = 0

  /** 用户切换时清空任务，旧账号的慢响应不会回流。 */
  function reset() {
    epoch++
    items.value = []
    error.value = ''
    pending = null
  }

  /** 多处同时刷新共用一个请求，减少任务中心和业务页面的重复访问。 */
  async function refresh() {
    if (pending) return pending
    const stamp = epoch
    pending = (async () => {
      try {
        const result = await api('/ai/jobs')
        if (stamp === epoch) {
          items.value = result
          revision.value++
          error.value = ''
        }
      } catch (e) {
        if (stamp === epoch) error.value = e.message
      } finally {
        if (stamp === epoch) pending = null
      }
    })()
    return pending
  }

  return { items, revision, error, refresh, reset }
})
