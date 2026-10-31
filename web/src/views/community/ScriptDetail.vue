<script setup>
/** 独立公开分享页：读取审核快照，提供点赞、收藏、评论和举报。 */
import { ref, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api/client'
import { useAuth } from '../../stores/auth'
import { dateLabel } from '../../shared/format'
import { reportError, success, askText, confirmAction } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import EmptyState from '../../components/EmptyState.vue'
import ReactionIcon from '../../components/ReactionIcon.vue'
import UserAvatar from '../../components/UserAvatar.vue'
import { useReactions } from '../../shared/useReactions'
const route = useRoute(),
  reactions = useReactions(),
  router = useRouter(),
  auth = useAuth(),
  script = ref(null),
  episode = ref(0),
  body = ref(''),
  error = ref(''),
  busy = ref(false),
  sending = ref(false)

/**
 * 读取当前路由对应的公开快照和互动状态，并限制选中集号不超过现有范围。
 */
async function load() {
  busy.value = true
  try {
    script.value = await api('/public/scripts/' + route.params.id)
    error.value = ''
    episode.value = Math.min(episode.value, script.value.episodes.length - 1)
  } catch (e) {
    error.value = e.message
    script.value = null
  } finally {
    busy.value = false
  }
}

/**
 * 检查互动前的登录状态；匿名用户跳转登录并携带当前页面作为返回地址。
 */
function logged() {
  if (auth.user) return true
  router.push('/login?redirect=' + encodeURIComponent(route.fullPath))
  return false
}

/**
 * 根据当前状态点赞或取消点赞，仅在接口成功后同步本地数量与状态。
 */
async function like() {
  await reactions.toggleLike(script.value)
}

/**
 * 切换当前剧本的收藏状态，仅在后端成功后更新页面。
 */
async function favorite() {
  await reactions.toggleFavorite(script.value)
}

/**
 * 提交评论后清空输入并重新加载公开内容，防止发送过程中重复操作。
 */
async function comment() {
  if (!logged()) return
  sending.value = true
  try {
    await api('/public/scripts/' + script.value.id + '/comments', {
      method: 'POST',
      body: { body: body.value },
    })
    body.value = ''
    await load()
    success('评论已发布')
  } catch (e) {
    reportError(e)
  } finally {
    sending.value = false
  }
}

/**
 * 确认后删除指定评论，再刷新页面；作者或管理员权限由后端校验。
 */
async function remove(c) {
  if (!(await confirmAction('删除这条评论？'))) return
  try {
    await api('/public/comments/' + c.id, { method: 'DELETE' })
    await load()
  } catch (e) {
    reportError(e)
  }
}

/**
 * 登录后收集举报原因并提交，取消输入时不发送请求。
 */
async function report() {
  if (!logged()) return
  const reason = await askText('举报内容', '请说明具体问题，管理员会审核处理')
  if (!reason) return
  try {
    await api('/public/scripts/' + script.value.id + '/report', { method: 'POST', body: { reason } })
    success('举报已提交，感谢你的反馈')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 将当前公开阅读地址复制到剪贴板，失败时提示浏览器错误。
 */
async function share() {
  try {
    await navigator.clipboard.writeText(location.href)
    success('分享链接已复制')
  } catch (e) {
    reportError(e)
  }
}

// 同一页面组件复用到另一部作品时，根据新的剧本 ID 重新加载。
watch(() => route.params.id, load)
onMounted(load)
</script>
<template>
  <div v-loading="busy">
    <EmptyState v-if="error" title="暂时无法阅读这部作品" :description="error"
      ><el-button @click="router.push('/community')">返回广场</el-button></EmptyState
    ><template v-else-if="script"
      ><PageHeading
        :title="script.title"
        :description="'by ' + script.author + ' · ' + script.genre + ' · ' + script.episodes.length + ' 集'"
        eyebrow="ORIGINAL STORY"
        ><el-button @click="share">分享链接</el-button
        ><el-button text @click="report">举报</el-button></PageHeading
      >
      <div class="read-intro panel">
        <p>{{ script.synopsis }}</p>
        <div class="tag-line">
          <span v-for="t in script.tags" :key="t">{{ t }}</span>
        </div>
        <div class="read-actions">
          <el-button
            class="like-button"
            :class="{ 'is-active': script.liked }"
            :aria-pressed="!!script.liked"
            :disabled="reactions.pending.has('like:' + script.id)"
            @click="like"
            ><ReactionIcon kind="like" :active="!!script.liked" />{{ script.liked ? '已点赞' : '点赞' }}
            {{ script.likes }}</el-button
          ><el-button
            class="favorite-button"
            :class="{ 'is-active': script.favorited }"
            :aria-pressed="!!script.favorited"
            :disabled="reactions.pending.has('favorite:' + script.id)"
            @click="favorite"
            ><ReactionIcon kind="favorite" :active="!!script.favorited" />{{
              script.favorited ? '已收藏' : '收藏作品'
            }}</el-button
          >
        </div>
      </div>
      <div class="read-layout">
        <aside class="panel read-outline">
          <h3>分集目录</h3>
          <button
            v-for="(e, i) in script.episodes"
            :key="e.id"
            :class="{ selected: episode === i }"
            @click="episode = i"
          >
            {{ e.title }}
          </button>
        </aside>
        <article class="writing-paper public-paper">
          <div class="paper-document-meta">ORIGINAL SCRIPT <span>公开审核版本</span></div>
          <h2>{{ script.episodes[episode]?.title }}</h2>
          <div class="script-rich-content" v-html="script.episodes[episode]?.content_html"></div>
        </article>
      </div>
      <section class="panel comments-panel">
        <div class="section-heading">
          <h2>
            聊聊这个故事 <span>{{ script.comments.length }} 条最近评论</span>
          </h2>
        </div>
        <div class="comment-input">
          <el-input
            v-model="body"
            type="textarea"
            :rows="3"
            maxlength="1000"
            show-word-limit
            placeholder="留下具体、友善的创作建议"
          /><el-button type="primary" :loading="sending" @click="comment">发表评论</el-button>
        </div>
        <p v-if="!script.comments.length" class="no-comments">还没有评论，来留下第一条创作建议。</p>
        <div v-for="c in script.comments" :key="c.id" class="reader-comment">
          <UserAvatar :src="c.avatarUrl" :name="c.nickname" />
          <div>
            <b>{{ c.nickname }}</b
            ><span>{{ dateLabel(c.created_at) }}</span>
            <p>{{ c.body }}</p>
          </div>
          <el-button
            v-if="auth.user?.id === c.user_id || auth.user?.role === 'admin'"
            text
            type="danger"
            @click="remove(c)"
            >删除</el-button
          >
        </div>
      </section></template
    >
  </div>
</template>
