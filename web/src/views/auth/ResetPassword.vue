<script setup>
/** 邮箱链接重置：一次性 token 交由后端验证，成功后所有旧会话失效。 */
import { ref } from 'vue'
import PageHeading from '../../components/PageHeading.vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from '../../api/client'
import { success, reportError } from '../../shared/feedback'
const route = useRoute(),
  router = useRouter(),
  password = ref(''),
  confirm = ref(''),
  busy = ref(false)

/**
 * 先核对两次密码，再提交链接中的一次性令牌及新密码；成功后返回登录页。
 */
async function submit() {
  if (password.value !== confirm.value) {
    reportError(new Error('两次密码不一致'))
    return
  }
  busy.value = true
  try {
    await api('/auth/password-reset/confirm', {
      method: 'POST',
      body: { token: route.query.token || '', password: password.value },
    })
    success('密码已重置，请重新登录')
    router.replace('/login')
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="reset-page panel">
    <PageHeading title="设置新密码" description="密码重置链接仅可使用一次。" /><el-form
      label-position="top"
      @submit.prevent="submit"
      ><el-form-item label="新密码"
        ><el-input v-model="password" type="password" show-password /></el-form-item
      ><el-form-item label="确认密码"
        ><el-input v-model="confirm" type="password" show-password /></el-form-item
      ><el-button type="primary" native-type="submit" :loading="busy">确认重置</el-button></el-form
    >
  </div>
</template>
