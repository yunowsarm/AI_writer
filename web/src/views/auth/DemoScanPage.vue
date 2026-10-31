<script setup>
/** 手机确认页：明确标注演示且必须主动确认，打开链接本身不会注册或授权电脑。 */
import { ref } from 'vue'
import { api } from '../../api/client'
const busy = ref(false),
  done = ref(false),
  message = ref(''),
  error = ref('')
async function confirm() {
  busy.value = true
  error.value = ''
  try {
    const result = await api('/auth/demo-qr/confirm', { method: 'POST', body: { ticket: location.hash.slice(1) } })
    done.value = true
    message.value = result.registered ? '新设备已创建演示账号，电脑即将登录。' : '已识别原有演示设备，电脑即将登录原账号。'
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <main class="demo-confirm">
    <section class="panel">
      <el-tag type="warning">开发演示 · 非真实微信登录</el-tag>
      <h1>确认登录电脑</h1>
      <p>此操作仅用于毕业设计测试，使用当前浏览器的设备凭据识别演示账号。</p>
      <p>请仅确认自己电脑上展示的二维码。首次确认会创建普通演示账号，再次使用同一浏览器会复用账号。</p>
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <el-alert v-if="done" :title="message" type="success" :closable="false" />
      <el-button v-else type="primary" :loading="busy" @click="confirm">确认演示登录</el-button>
    </section>
  </main>
</template>
<style scoped>
.demo-confirm {
  margin: 0 auto;
  padding: 40px 20px;
  max-width: 520px;
}
.panel {
  padding: 26px;
}
h1 {
  font-size: 24px;
  margin: 20px 0;
}
p {
  line-height: 1.8;
  margin-bottom: 20px;
}
.el-button {
  width: 100%;
  margin-top: 18px;
}
</style>
