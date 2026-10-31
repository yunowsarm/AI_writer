<script setup>
/** 内容统计图标：采用 Lucide 的 message-circle 和 eye，与点赞统一线宽及画布。
 * 许可证见 assets/icons/LUCIDE-LICENSE.txt；图标语义由外层统计项提供。
 */
defineProps({ kind: { type: String, default: 'comment' } })
</script>

<template>
  <svg
    class="content-metric-icon"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-if="kind === 'comment'" d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
    <template v-else>
      <path
        d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"
      />
      <circle cx="12" cy="12" r="3" />
    </template>
  </svg>
</template>

<style scoped>
.content-metric-icon {
  display: inline-flex;
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
</style>
