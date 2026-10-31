<script setup>
import { newWindowScope, setWindowScope } from '../../api/windowSession'
/** 账号入口：注册、登录、真实微信授权与邮箱找回；未配置能力不可伪装成功。 */
import { ref, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { api } from '../../api/client'
import { success } from '../../shared/feedback'
import StudioLogo from '../../components/StudioLogo.vue'
import DemoQrLogin from './DemoQrLogin.vue'
const demoQr = ref(null)
const route = useRoute(),
  router = useRouter(),
  auth = useAuth(),
  mode = ref('login'),
  loading = ref(false),
  error = ref(route.query.error || ''),
  form = ref({ email: '', password: '', nickname: '', code: '' })
const countdown = ref(0),
  sending = ref(false)
let timer
onBeforeUnmount(() => clearInterval(timer))

/** 按注册、登录、找回用途发送验证码，倒计时防止误重复提交。 */
async function sendCode() {
  if (countdown.value || sending.value) return
  sending.value = true
  error.value = ''
  try {
    await api('/auth/email-code', { method: 'POST', body: { email: form.value.email, purpose: mode.value === 'register' ? 'register' : mode.value === 'reset' ? 'reset' : 'login' } })
    countdown.value = 60
    clearInterval(timer)
    timer = setInterval(() => {
      if (--countdown.value <= 0) clearInterval(timer)
    }, 1000)
    success('验证码已发送，十分钟内有效')
  } catch (e) {
    error.value = e.message
  } finally {
    sending.value = false
  }
}

/**
 * 跳转后端微信授权入口，由服务端生成一次性 state 并发起扫码登录。
 */
function wechatLogin() {
  const scope = newWindowScope()
  setWindowScope(scope)
  window.location.assign('/api/auth/wechat?window=' + scope)
}

/**
 * 按当前模式提交登录、注册或密码重置邮件请求。
 * 登录成功只允许跳转到以单斜杠开头的站内地址，避免外部重定向。
 */
async function submit() {
  error.value = ''
  loading.value = true
  try {
    if (mode.value === 'reset') {
      await api('/auth/email-reset', { method: 'POST', body: form.value })
      success('密码已重置，请重新登录')
      mode.value = 'login'
      form.value.password = ''
      form.value.code = ''
    } else if (mode.value === 'email') {
      const scope = newWindowScope()
      await api('/auth/email-login', { method: 'POST', body: form.value, headers: { 'X-Window-Session': scope } })
      setWindowScope(scope)
      await auth.init()
      router.replace('/')
    } else {
      await auth.login(form.value, mode.value === 'register')
      const to = typeof route.query.redirect === 'string' && route.query.redirect.startsWith('/') && !route.query.redirect.startsWith('//') ? route.query.redirect : '/'
      router.replace(to)
    }
  } catch (e) {
    error.value = e.message + (e.details?.length ? '：' + e.details[0].message : '')
  } finally {
    loading.value = false
  }
}
</script>
<template>
  <div class="auth-page">
    <section class="auth-story">
      <router-link class="brand" to="/" aria-label="回到创作工作台" title="回到创作工作台"><StudioLogo /></router-link>
      <div>
        <span>YOUR NEXT STORY STARTS HERE</span>
        <h1>
          灵感落笔，
          <br />
          让每一幕都有故事。
        </h1>
        <p>
          为每个想讲故事的人，
          <br />
          留一张安静的创作书桌。
        </p>
        <div class="auth-art">「 故事的下一幕，由你定义。 」</div>
      </div>
      <small>AI 辅助创作 · 你的表达始终是主角</small>
    </section>
    <section class="auth-card">
      <div class="eyebrow">WELCOME TO YOUR CREATIVE SPACE</div>
      <h2>
        {{ mode === 'login' ? '欢迎回到创作空间' : mode === 'register' ? '开始你的创作旅程' : mode === 'email' ? '邮箱验证码登录' : '找回账号密码' }}
      </h2>
      <p>把脑海里的世界，写成值得被看见的故事。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item v-if="mode === 'register'" label="创作者昵称"><el-input v-model="form.nickname" maxlength="40" autocomplete="nickname" /></el-form-item>
        <el-form-item label="账号邮箱"><el-input v-model="form.email" type="email" autocomplete="username" placeholder="输入你的邮箱" /></el-form-item>
        <el-form-item v-if="mode !== 'email'" :label="mode === 'reset' ? '新密码' : '密码'">
          <el-input v-model="form.password" type="password" show-password :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" placeholder="至少 8 位字符" />
        </el-form-item>
        <el-form-item v-if="auth.capabilities.emailCode && mode !== 'login'" label="邮箱验证码">
          <el-input v-model="form.code" maxlength="6" inputmode="numeric" placeholder="输入六位验证码">
            <template #append>
              <el-button :loading="sending" :disabled="countdown > 0" @click="sendCode">{{ countdown ? countdown + ' 秒后重发' : '获取验证码' }}</el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-button native-type="submit" type="primary" class="full-width" :loading="loading">
          {{ mode === 'register' ? '注册并进入工作台' : mode === 'reset' ? '确认重置密码' : '登录工作台' }}
          <el-icon v-if="mode === 'login'" class="inline-icon" aria-hidden="true"><Right /></el-icon>
        </el-button>
      </el-form>
      <div class="auth-links">
        <button
          v-if="auth.capabilities.emailCode"
          @click="
            () => {
              mode = mode === 'email' ? 'login' : 'email'
              error = ''
              form.code = ''
            }
          ">
          {{ mode === 'email' ? '账号密码登录' : '邮箱验证码登录' }}
        </button>
        <button
          @click="
            () => {
              mode = mode === 'register' ? 'login' : 'register'
              error = ''
            }
          ">
          {{ mode === 'register' ? '已有账号，去登录' : '创建新账号' }}
        </button>
        <button
          v-if="auth.capabilities.passwordReset"
          @click="
            () => {
              mode = 'reset'
              error = ''
            }
          ">
          忘记密码
        </button>
      </div>
      <el-divider>其他登录方式</el-divider>
      <el-button v-if="auth.capabilities.demoQr" class="full-width" @click="demoQr.show()">扫码登录（开发演示）</el-button>
      <el-button class="full-width" :disabled="!auth.capabilities.wechat" @click="wechatLogin">微信快捷登录{{ auth.capabilities.wechat ? '' : '（待配置）' }}</el-button>
      <p class="fine muted">微信首次授权将自动创建账号，无需预先注册。</p>
      <p class="fine muted">
        首次管理员凭据在项目 .local/首次登录.txt。
        <br />
        普通用户可直接注册；账号与作品将保存到 MySQL。
      </p>
      <router-link to="/community" class="guest-link">
        先去广场看看
        <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
      </router-link>
    </section>
  </div>
  <DemoQrLogin ref="demoQr" />
</template>
