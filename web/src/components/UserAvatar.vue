<script setup>
/** 统一头像：图片填满圆形，无内边距和白色边框；未上传或加载失败时显示昵称首字。 */
import { computed, ref, watch } from 'vue'
const props = defineProps({ src: { type: String, default: '' }, name: { type: String, default: '访客' }, size: { type: String, default: '' } })
const failed = ref(false)
const initial = computed(() => Array.from(props.name || '访客')[0])
watch(
  () => props.src,
  () => {
    failed.value = false
  }
)
</script>

<template>
  <span class="avatar user-avatar" :class="size" :title="name">
    <img v-if="src && !failed" :src="src" :alt="name + '的头像'" decoding="async" @error="failed = true" />
    <template v-else>{{ initial }}</template>
  </span>
</template>

<style scoped>
.avatar.user-avatar {
  padding: 0;
  border: 0;
  box-shadow: none;
  overflow: hidden;
  vertical-align: middle;
}
.user-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
