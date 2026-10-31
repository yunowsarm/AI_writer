<script setup>
import { getWindowScope } from '../../api/windowSession'
/** 个人中心：资料与密码真实保存；统计、浏览历史从 MySQL 聚合。 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import { useAuth } from '../../stores/auth'
import { dateLabel } from '../../shared/format'
import { reportError, success, confirmAction } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import AccountEmailVerification from './AccountEmailVerification.vue'
import AvatarEditor from './AvatarEditor.vue'
const auth = useAuth(),
  router = useRouter(),
  profile = ref({ ...auth.user }),
  stats = ref({}),
  history = ref([]),
  passwordOpen = ref(false),
  password = ref({ oldPassword: '', newPassword: '', confirm: '' }),
  busy = ref(false)

/**
 * 并行加载创作统计与个人浏览历史。
 */
async function load() {
  try {
    ;[stats.value, history.value] = await Promise.all([api('/me/stats'), api('/me/history')])
  } catch (e) {
    reportError(e)
  }
}

/**
 * 保存昵称和简介后刷新全局用户资料，使导航中的昵称同步更新。
 */
async function save() {
  busy.value = true
  try {
    await api('/me', { method: 'PATCH', body: { nickname: profile.value.nickname, bio: profile.value.bio } })
    await auth.refresh()
    success('个人资料已更新')
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 先校验两次新密码，再请求修改密码；成功后清空密码表单并关闭弹窗。
 */
async function changePassword() {
  if (password.value.newPassword !== password.value.confirm) {
    reportError(new Error('两次输入的新密码不一致'))
    return
  }
  try {
    await api('/auth/password/change', { method: 'POST', body: password.value })
    passwordOpen.value = false
    password.value = { oldPassword: '', newPassword: '', confirm: '' }
    success('密码已修改，其他设备的登录已失效')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 确认后清空浏览历史，并重新加载个人中心统计。
 */
async function clearHistory() {
  if (!(await confirmAction('清空所有浏览记录？'))) return
  try {
    await api('/me/history', { method: 'DELETE' })
    await load()
    success('浏览记录已清空')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 跳转微信绑定入口；服务端将授权 state 与当前账号关联。
 */
function bindWechat() {
  window.location.assign('/api/auth/wechat?bind=1&window=' + getWindowScope())
}
onMounted(load)
</script>
<template>
  <PageHeading title="每个故事背后，都有一个你。" description="管理个人资料，看看一路积累的创作足迹。">
    <el-button @click="router.push('/usage')">AI 用量</el-button>
    <el-button @click="router.push('/settings/api')">我的 API 配置</el-button>
  </PageHeading>
  <div class="profile-layout">
    <section class="panel profile-form">
      <div class="profile-banner">
        <AvatarEditor />
        <div>
          <h2>{{ auth.user.nickname }}</h2>
          <p>{{ auth.user.role === 'admin' ? '系统管理员' : '自由创作者' }} · {{ dateLabel(auth.user.createdAt) }} 加入</p>
        </div>
      </div>
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="创作者昵称"><el-input v-model="profile.nickname" maxlength="40" /></el-form-item>
        <el-form-item label="个人简介"><el-input v-model="profile.bio" type="textarea" :rows="4" maxlength="500" show-word-limit /></el-form-item>
        <el-form-item label="账号邮箱"><el-input :model-value="profile.email || '微信授权账号'" disabled /></el-form-item>
        <el-button type="primary" native-type="submit" :loading="busy">保存修改</el-button>
      </el-form>
      <el-divider />
      <AccountEmailVerification />
      <div class="security-row">
        <div>
          <b>账号密码</b>
          <p>修改后其他设备将退出登录</p>
        </div>
        <el-button @click="passwordOpen = true">修改密码</el-button>
      </div>
      <div class="security-row">
        <div>
          <b>微信快捷登录</b>
          <p>{{ auth.capabilities.wechat ? '绑定后可通过微信登录' : '填写微信网站应用配置后启用' }}</p>
        </div>
        <el-button :disabled="!auth.capabilities.wechat" @click="bindWechat">绑定微信</el-button>
      </div>
    </section>
    <section class="panel">
      <h2>我的创作足迹</h2>
      <div class="profile-stats">
        <div>
          <b>{{ stats.scripts || 0 }}</b>
          部剧本
        </div>
        <div>
          <b>{{ stats.favorites || 0 }}</b>
          个收藏
        </div>
        <div>
          <b>{{ stats.history || 0 }}</b>
          条浏览
        </div>
      </div>
      <el-divider />
      <div class="section-heading">
        <h2>最近浏览</h2>
        <el-button v-if="history.length" text @click="clearHistory">清空记录</el-button>
      </div>
      <el-empty v-if="!history.length" description="去广场读一个新故事吧" :image-size="80" />
      <div v-for="h in history" :key="h.id" class="history-row" @click="router.push('/s/' + h.id)">
        <el-icon><Document /></el-icon>
        {{ h.title }}
        <span>
          {{ dateLabel(h.viewed_at) }}
          <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
        </span>
      </div>
    </section>
  </div>
  <el-dialog v-model="passwordOpen" title="修改账号密码" width="450px">
    <el-form label-position="top" @submit.prevent="changePassword">
      <el-form-item label="当前密码"><el-input v-model="password.oldPassword" type="password" show-password autocomplete="current-password" /></el-form-item>
      <el-form-item label="新密码（至少 8 位）"><el-input v-model="password.newPassword" type="password" show-password autocomplete="new-password" /></el-form-item>
      <el-form-item label="确认新密码"><el-input v-model="password.confirm" type="password" show-password autocomplete="new-password" /></el-form-item>
    </el-form>
    <div style="display: flex; justify-content: flex-end">
      <el-button native-type="submit" type="primary">确认修改</el-button>
    </div>
  </el-dialog>
</template>
