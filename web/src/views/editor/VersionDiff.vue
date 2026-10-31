<script setup>
/** 历史快照对比：删除与新增分别呈现，旧版本内容始终可追溯。 */
import { computed } from 'vue'
import { diffText } from './textDiff'
const props = defineProps({ before: { type: String, default: '' }, after: { type: String, default: '' }, caption: { type: String, default: '历史版本 → 当前稿' } })
const parts = computed(() => diffText(props.before, props.after))
const same = computed(() => parts.value.every((p) => p.type === 'equal'))
</script>
<template>
  <p class="diff-legend">
    {{ caption }} ·
    <span class="added">绿色为新增</span>
    ·
    <span class="removed">红色为删除</span>
  </p>
  <el-empty v-if="same" description="历史版本与当前正文一致" :image-size="60" />
  <div v-else class="version-diff">
    <template v-for="(part, i) in parts" :key="i">
      <ins v-if="part.type === 'insert'">{{ part.text }}</ins>
      <del v-else-if="part.type === 'delete'">{{ part.text }}</del>
      <span v-else>{{ part.text }}</span>
    </template>
  </div>
</template>
<style scoped>
.diff-legend {
  margin-bottom: 16px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.version-diff {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 2;
  max-height: 60vh;
  overflow: auto;
  font-size: 16px;
}
.version-diff ins,
.added {
  color: var(--review-added-ink);
  background: var(--el-color-success-light-9);
  text-decoration: none;
}
.version-diff del,
.removed {
  color: var(--review-deleted-ink);
  background: var(--el-color-danger-light-9);
}
</style>
