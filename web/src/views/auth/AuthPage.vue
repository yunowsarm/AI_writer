<script setup>
import { newWindowScope, setWindowScope } from '../../api/windowSession'
/** 账号入口：注册、登录、真实微信授权与邮箱找回；未配置能力不可伪装成功。 */
import { ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { api } from '../../api/client'
import { success } from '../../shared/feedback'
import StudioLogo from '../../components/StudioLogo.vue'
import DemoQrLogin from './DemoQrLogin.vue'
import { useEmailCode, validEmail } from '../../shared/useEmailCode'
const demoQr = ref(null)
const route = useRoute(),
  router = useRouter(),
  auth = useAuth(),
  mode = ref('login'),
  loading = ref(false),
  error = ref(route.query.error || ''),
  form = ref({ email: '', password: '', nickname: '', code: '' })
const registerStep = ref(1)
const { countdown, sending, send } = useEmailCode(
  () => form.value.email,
  () => (mode.value === 'register' ? 'register' : mode.value === 'reset' ? 'reset' : 'login')
)

// 切换用途或收件邮箱后清空旧验证码；同一邮箱用途的发送冷却仍由组合函数保留。
watch(mode, () => {
  registerStep.value = 1
  form.value.code = ''
  error.value = ''
})
watch(
  () => form.value.email,
  () => {
    form.value.code = ''
  }
)

/** 返回账号资料步骤，清除验证码，不重置已发送邮件的冷却时间。 */
function editRegistration() {
  registerStep.value = 1
  form.value.code = ''
  error.value = ''
}

/** 按注册、登录、找回用途发送验证码，倒计时防止误重复提交。 */
async function sendCode() {
  error.value = ''
  try {
    if (await send()) success('验证码已发送，请查看邮箱，十分钟内有效')
  } catch (e) {
    error.value = e.message
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
  if (loading.value || sending.value) return
  if (mode.value !== 'login' && !auth.capabilities.emailCode) {
    error.value = '邮箱验证服务尚未配置，请联系管理员；已有账号仍可使用密码登录'
    return
  }
  if (!validEmail(form.value.email)) {
    error.value = '请填写有效的邮箱地址'
    return
  }
  if (mode.value === 'register' && registerStep.value === 1) {
    if (!form.value.nickname.trim()) {
      error.value = '请填写创作者昵称'
      return
    }
    if (form.value.password.length < 8 || form.value.password.length > 128) {
      error.value = '密码需要 8～128 位字符'
      return
    }
    registerStep.value = 2
    return
  }
  if (mode.value !== 'login' && !/^\d{6}$/.test(form.value.code)) {
    error.value = '请输入邮件中的六位验证码'
    return
  }
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
      <el-steps v-if="mode === 'register'" :active="registerStep - 1" simple class="registration-steps">
        <el-step title="填写账号信息" />
        <el-step title="验证邮箱" />
      </el-steps>
      <el-alert v-if="mode !== 'login' && !auth.capabilities.emailCode" title="邮箱验证服务尚未配置，暂时无法注册或使用验证码。请联系管理员配置邮件服务。" type="warning" :closable="false" show-icon />
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <el-form label-position="top" @submit.prevent="submit">
        <el-form-item v-if="mode === 'register' && registerStep === 1" label="创作者昵称"><el-input v-model="form.nickname" maxlength="40" autocomplete="nickname" /></el-form-item>
        <el-form-item label="账号邮箱">
          <el-input v-model="form.email" :readonly="mode === 'register' && registerStep === 2" :disabled="sending || loading" type="email" autocomplete="username" placeholder="输入你的邮箱" />
        </el-form-item>
        <p v-if="mode === 'register' && registerStep === 2" class="verification-note">请获取并填写该邮箱收到的验证码。验证通过后才会创建账号。</p>
        <el-form-item v-if="mode !== 'email' && !(mode === 'register' && registerStep === 2)" :label="mode === 'reset' ? '新密码' : '密码'">
          <el-input v-model="form.password" type="password" show-password :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" placeholder="至少 8 位字符" />
        </el-form-item>
        <el-form-item v-if="mode === 'email' || mode === 'reset' || (mode === 'register' && registerStep === 2)" label="邮箱验证码">
          <el-input v-model="form.code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" placeholder="输入六位验证码">
            <template #append>
              <el-button :loading="sending" :disabled="countdown > 0 || !auth.capabilities.emailCode || loading || !validEmail(form.email)" @click="sendCode">
                {{ countdown ? countdown + ' 秒后重发' : '获取验证码' }}
              </el-button>
            </template>
          </el-input>
        </el-form-item>
        <el-button v-if="mode === 'register' && registerStep === 2" text :disabled="sending || loading" @click="editRegistration">返回修改账号信息</el-button>
        <el-button native-type="submit" type="primary" class="full-width" :loading="loading" :disabled="sending || (mode !== 'login' && !auth.capabilities.emailCode)">
          {{ mode === 'register' ? (registerStep === 1 ? '下一步：验证邮箱' : '验证并创建账号') : mode === 'reset' ? '确认重置密码' : '登录工作台' }}
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
        新账号需要验证邮箱后注册；账号与作品将保存到 MySQL。
      </p>
      <router-link to="/community" class="guest-link">
        先去广场看看
        <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
      </router-link>
    </section>
  </div>
  <DemoQrLogin ref="demoQr" />
</template>

<style scoped>
.registration-steps {
  margin: 20px 0;
}
.verification-note {
  color: var(--el-text-color-regular);
  line-height: 1.7;
  margin: 0 0 18px;
}
</style>
