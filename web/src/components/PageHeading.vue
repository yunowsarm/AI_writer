<script setup>
// 页面标题与操作区的通用布局，不持有业务数据。
defineProps({
  title: String,
  // 可选的全局 SVG 图标名称，只补充标题装饰，不改变标题文字。
  icon: String,
  description: String,
  eyebrow: { type: String, default: 'CREATIVE STUDIO' },
})
</script>
<template>
  <div class="page-heading">
    <div>
      <div class="eyebrow">{{ eyebrow }}</div>
      <h1>
        {{ title
        }}<el-icon v-if="icon" class="heading-icon" aria-hidden="true"><component :is="icon" /></el-icon>
      </h1>
      <p v-if="description">{{ description }}</p>
    </div>
    <div class="heading-actions"><slot /></div>
  </div>
</template>
