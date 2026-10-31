<script setup>
/** 头像设置：本地预览与持久化分开，只有保存成功后才同步各处用户头像。 */
import { ref } from 'vue'
import { useAuth } from '../../stores/auth'
import { api } from '../../api/client'
import { prepareAvatar } from '../../shared/avatarImage'
import { reportError, success, confirmAction } from '../../shared/feedback'
import UserAvatar from '../../components/UserAvatar.vue'
const auth = useAuth(),
  open = ref(false),
  preview = ref(''),
  preparing = ref(false),
  saving = ref(false),
  picker = ref(null)
let selection = 0

function show() {
  preview.value = ''
  open.value = true
}

/** 快速连续选择文件时，仅保留最后一次完成的预览。 */
async function selected(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  const current = ++selection
  preparing.value = true
  try {
    const image = await prepareAvatar(file)
    if (current === selection) preview.value = image
  } catch (error) {
    if (current === selection) reportError(error)
  } finally {
    if (current === selection) preparing.value = false
  }
}

async function save() {
  if (!preview.value || saving.value || preparing.value) return
  saving.value = true
  try {
    auth.user = await api('/me/avatar', { method: 'PUT', body: { image: preview.value } })
    open.value = false
    preview.value = ''
    success('头像已更新')
  } catch (error) {
    reportError(error)
  } finally {
    saving.value = false
  }
}

async function reset() {
  if (saving.value || !(await confirmAction('移除上传的头像，恢复为昵称首字头像？'))) return
  saving.value = true
  try {
    auth.user = await api('/me/avatar', { method: 'DELETE' })
    preview.value = ''
    open.value = false
    success('已恢复默认头像')
  } catch (error) {
    reportError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <button type="button" class="avatar-edit-trigger" title="更换头像" aria-label="更换头像" @click="show">
    <UserAvatar :src="auth.user?.avatarUrl" :name="auth.user?.nickname" size="big" />
    <span class="avatar-edit-label">更换</span>
  </button>
  <el-dialog v-model="open" title="更换头像" width="min(440px, 92vw)" append-to-body :close-on-click-modal="!saving" :close-on-press-escape="!saving" :show-close="!saving">
    <div class="avatar-preview">
      <UserAvatar :src="preview || auth.user?.avatarUrl" :name="auth.user?.nickname" />
      <p>图片将居中裁剪为圆形，预览确认后保存。</p>
      <p>支持 JPG、PNG、WebP，原图不超过 5MB。</p>
      <input ref="picker" type="file" accept="image/jpeg,image/png,image/webp" class="avatar-file" aria-label="选择头像图片" @change="selected" />
      <el-button :loading="preparing" :disabled="saving" @click="picker.click()">{{ preview ? '重新选择图片' : '选择图片' }}</el-button>
    </div>
    <template #footer>
      <div class="avatar-dialog-actions">
        <el-button v-if="auth.user?.avatarUrl" text :disabled="saving || preparing" @click="reset">恢复默认</el-button>
        <span class="avatar-actions-spacer" />
        <el-button :disabled="saving" @click="open = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!preview || preparing" @click="save">保存头像</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.avatar-edit-trigger {
  display: inline-flex;
  position: relative;
  padding: 0;
  border: 0;
  border-radius: 50%;
  flex-shrink: 0;
  overflow: hidden;
}
.avatar-edit-label {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 3px 0;
  color: white;
  background: rgb(0 0 0 / 45%);
  font-size: 11px;
  transition: background-color 0.2s ease;
}
.avatar-edit-trigger:hover .avatar-edit-label {
  background: rgb(0 0 0 / 65%);
}
.avatar-preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 8px 0 20px;
}
.avatar-preview :deep(.user-avatar) {
  width: 144px;
  height: 144px;
  font-size: 48px;
}
.avatar-preview p {
  color: var(--el-text-color-regular);
  text-align: center;
  line-height: 1.6;
}
.avatar-file {
  display: none;
}
.avatar-dialog-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.avatar-actions-spacer {
  flex: 1;
}
</style>
