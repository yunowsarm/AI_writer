/** 互动操作：统一登录检查、单项防重复请求和成功后更新，供卡片与阅读页复用。 */
import { reactive } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../stores/auth'
import { api } from '../api/client'
import { reportError, success } from './feedback'

export function useReactions() {
  const pending = reactive(new Set()),
    auth = useAuth(),
    route = useRoute(),
    router = useRouter()

  /** 单项操作加锁；接口失败时保留原状态，匿名用户登录后回到当前页。 */
  async function perform(key, work) {
    if (!auth.user) {
      router.push({ path: '/login', query: { redirect: route.fullPath } })
      return false
    }
    if (pending.has(key)) return false
    pending.add(key)
    try {
      await work()
      return true
    } catch (error) {
      reportError(error)
      return false
    } finally {
      pending.delete(key)
    }
  }

  /** 根据服务端返回的本人状态切换收藏，仅在成功后改变图标状态。 */
  function toggleFavorite(item, type = 'script') {
    return perform('favorite:' + item.id, async () => {
      await api(`/favorites/${type}/${item.id}`, { method: item.favorited ? 'DELETE' : 'PUT' })
      item.favorited = !item.favorited
      success(item.favorited ? '已收藏' : '已取消收藏')
    })
  }

  /** 切换点赞并同步数量，限制最小计数为零；失败时不提前显示成功状态。 */
  function toggleLike(item) {
    return perform('like:' + item.id, async () => {
      const wasLiked = !!item.liked
      await api('/public/scripts/' + item.id + '/like', { method: wasLiked ? 'DELETE' : 'PUT' })
      item.likes = Math.max(0, Number(item.likes || 0) + (wasLiked ? -1 : 1))
      item.liked = !wasLiked
    })
  }

  return { pending, toggleFavorite, toggleLike }
}
