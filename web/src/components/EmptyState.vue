<script setup>
// 空数据、加载失败和首次创作使用一致的反馈样式。
defineProps({ title: { type: String, default: '这里还没有故事' }, description: String })
</script>
<template>
  <div class="empty panel">
    <el-icon><FolderOpened /></el-icon>
    <h3>{{ title }}</h3>
    <p>{{ description || '从一个灵感开始，写下你的第一幕。' }}</p>
    <slot />
  </div>
</template>
