<script setup>
/** 个人邮箱验证入口：仅验证当前账号已有邮箱，不在此更换邮箱或代验其他账号。 */
import { ref } from 'vue'
import { useAuth } from '../../stores/auth'
import { api } from '../../api/client'
import { useEmailCode } from '../../shared/useEmailCode'
import { reportError, success } from '../../shared/feedback'
const auth = useAuth(),
  open = ref(false),
  code = ref(''),
  verifying = ref(false)
const { countdown, sending, send } = useEmailCode(() => auth.user?.email || '', 'verify')

/** 每次打开都清空旧输入，保留同一邮箱的发送倒计时。 */
function showVerification() {
  open.value = true
  code.value = ''
}

async function sendCode() {
  try {
    if (await send()) success('验证码已发送，请查看当前账号邮箱')
  } catch (error) {
    reportError(error)
  }
}

/** 验证成功后从服务端刷新状态，不在浏览器自行写入已验证标记。 */
async function verify() {
  if (verifying.value || sending.value) return
  if (!/^\d{6}$/.test(code.value)) {
    reportError(new Error('请输入六位邮箱验证码'))
    return
  }
  verifying.value = true
  try {
    await api('/auth/email-verify', { method: 'POST', body: { code: code.value } })
    await auth.refresh()
    open.value = false
    code.value = ''
    success('邮箱验证成功')
  } catch (error) {
    reportError(error)
  } finally {
    verifying.value = false
  }
}
</script>

<template>
  <div class="security-row">
    <div>
      <b>
        邮箱验证
        <el-tag :type="auth.user?.emailVerified ? 'success' : 'warning'" size="small">{{ auth.user?.emailVerified ? '已验证' : '未验证' }}</el-tag>
      </b>
      <p>
        {{
          !auth.user?.email
            ? '当前第三方账号尚未绑定邮箱'
            : auth.user.emailVerified
              ? '已确认该邮箱由你持有'
              : auth.capabilities.emailCode
                ? '请验证邮箱，确认账号邮箱可以正常接收邮件'
                : '邮件服务尚未配置，请联系管理员后再验证'
        }}
      </p>
    </div>
    <el-button v-if="!auth.user?.emailVerified" :disabled="!auth.user?.email || !auth.capabilities.emailCode" @click="showVerification">验证邮箱</el-button>
  </div>
  <el-dialog v-model="open" title="验证账号邮箱" width="min(480px, 92vw)" append-to-body :close-on-click-modal="!verifying">
    <p>
      验证码将发送至
      <strong>{{ auth.user?.email }}</strong>
      ，十分钟内有效。
    </p>
    <el-form label-position="top" @submit.prevent="verify">
      <el-form-item label="六位邮箱验证码">
        <el-input v-model="code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" placeholder="填写邮件中的验证码">
          <template #append>
            <el-button :loading="sending" :disabled="countdown > 0 || verifying" @click="sendCode">{{ countdown ? countdown + ' 秒后重发' : '获取验证码' }}</el-button>
          </template>
        </el-input>
      </el-form-item>
      <el-button native-type="submit" type="primary" :loading="verifying" :disabled="sending">确认验证</el-button>
    </el-form>
  </el-dialog>
</template>
