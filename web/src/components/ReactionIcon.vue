<script setup>
/** 互动状态图标：点赞采用 Lucide thumbs-up，收藏复用 Element Plus 星形；实心表示已选中。
 * Lucide 来源：https://lucide.dev/icons/thumbs-up，许可证见 assets/icons/LUCIDE-LICENSE.txt。
 */
import { Star, StarFilled } from '@element-plus/icons-vue'
defineProps({ kind: { type: String, default: 'like' }, active: Boolean })
</script>
<template>
  <svg
    v-if="kind === 'like'"
    class="reaction-icon"
    viewBox="0 0 24 24"
    :fill="active ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    :data-state="active ? 'selected' : 'unselected'"
  >
    <path
      d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"
    />
    <path d="M7 10v12" :stroke="active ? 'var(--el-bg-color)' : 'currentColor'" />
  </svg>
  <el-icon v-else class="reaction-icon" aria-hidden="true" :data-state="active ? 'selected' : 'unselected'"
    ><StarFilled v-if="active" /><Star v-else
  /></el-icon>
</template>
<style scoped>
.reaction-icon {
  display: inline-flex;
  width: 1em;
  height: 1em;
  flex-shrink: 0;
  vertical-align: middle;
}
</style>
