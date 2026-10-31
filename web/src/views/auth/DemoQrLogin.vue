<script setup>
/** 演示扫码电脑端：二维码只携带短期票据，最终登录通过本机 HttpOnly 凭据消费。 */
import { ref, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import QRCode from 'qrcode'
import { api } from '../../api/client'
import { useAuth } from '../../stores/auth'
const open = ref(false),
  image = ref(''),
  url = ref(''),
  error = ref(''),
  busy = ref(false)
const auth = useAuth(),
  router = useRouter()
let timer,
  ticket,
  version = 0

/** 刷新二维码会取消旧的本地轮询，过期票据由后端拒绝。 */
async function show() {
  open.value = true
  busy.value = true
  error.value = ''
  image.value = ''
  clearTimeout(timer)
  const stamp = ++version
  try {
    const result = await api('/auth/demo-qr', { method: 'POST', body: {} })
    if (stamp !== version) return
    ticket = result.ticket
    url.value = location.origin + '/demo-scan#' + ticket
    image.value = await QRCode.toDataURL(url.value, { width: 260, margin: 2 })
    timer = setTimeout(() => poll(stamp), 2000)
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

/** 轮询确认状态；关闭弹窗或组件卸载后丢弃慢响应。 */
async function poll(stamp) {
  if (!open.value || stamp !== version) return
  try {
    const result = await api('/auth/demo-qr/status', { method: 'POST', body: { ticket } })
    if (!open.value || stamp !== version) return
    if (result.status === 'completed') {
      await auth.init()
      open.value = false
      router.replace('/')
      return
    }
    timer = setTimeout(() => poll(stamp), 2000)
  } catch (e) {
    error.value = e.message
  }
}

function close() {
  version++
  clearTimeout(timer)
}
onBeforeUnmount(close)
defineExpose({ show })
</script>
<template>
  <el-dialog v-model="open" title="扫码登录 · 开发演示" width="min(94vw, 400px)" append-to-body @close="close">
    <el-alert title="仅模拟设备识别，不获取微信身份" type="warning" :closable="false" />
    <div class="demo-qr" v-loading="busy"><img v-if="image" :src="image" alt="演示登录二维码，两分钟有效" /></div>
    <p>手机首次确认创建演示账号；同一浏览器再次扫码沿用该账号。清除 Cookie 或更换浏览器会视为新设备。</p>
    <p class="hint">手机与电脑需能访问同一网站地址。127.0.0.1 仅供本机测试，可点下方链接模拟扫码。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template #footer>
      <el-button @click="show">刷新二维码</el-button>
      <a v-if="url" :href="url" target="_blank" rel="noopener">本机打开确认页</a>
    </template>
  </el-dialog>
</template>
<style scoped>
.demo-qr {
  min-height: 270px;
  text-align: center;
  background: #fff;
  margin: 16px 0;
  border-radius: 10px;
}
.demo-qr img {
  width: 260px;
  max-width: 100%;
}
p {
  font-size: 14px;
  line-height: 1.8;
}
.hint {
  color: var(--el-text-color-secondary);
}
a {
  color: var(--el-color-primary);
  margin-left: 12px;
}
</style>
