<script setup>
/** 重复段落处理：删除是确定性编辑，先展示完整范围，再由作者确认，不调用模型。 */
defineProps({ candidate: Object, busy: Boolean, canRewrite: Boolean })
const emit = defineEmits(['cancel', 'confirm', 'rewrite'])
</script>
<template>
  <el-dialog
    :model-value="!!candidate"
    class="quality-delete-dialog"
    title="处理重复段落"
    width="min(94vw, 920px)"
    top="5vh"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @close="emit('cancel')">
    <template v-if="candidate">
      <el-alert title="先确认这不是刻意回环、回忆或不同场景中的重复表达。删除会移除下面展示的完整段落。" type="warning" :closable="false" show-icon />
      <p class="delete-location">第 {{ candidate.episodeNo }} 集 · {{ candidate.text.length }} 字 · 确认删除不会调用 AI</p>
      <div class="delete-comparison">
        <section>
          <h4>将删除的完整段落</h4>
          <pre class="removed">{{ candidate.text }}</pre>
        </section>
        <section>
          <h4>删除后附近正文</h4>
          <pre>{{ candidate.preview || '这一段删除后，本集将保留为空白正文。' }}</pre>
        </section>
      </div>
      <div v-if="candidate.references.length" class="duplicate-references">
        <h4>报告中的对照原文（评估时）</h4>
        <p v-for="(reference, i) in candidate.references" :key="i">第 {{ reference.episodeNo }} 集 · {{ reference.quote }}</p>
      </div>
      <p class="delete-note">删除后会自动保存，并用红色标出本轮删除；可通过撤销或版本记录恢复。若两处都有独立信息，可选择保留并改写。</p>
    </template>
    <template #footer>
      <div class="delete-actions">
        <el-button :disabled="busy" @click="emit('cancel')">返回报告</el-button>
        <el-button :disabled="busy || !canRewrite" @click="emit('rewrite')">保留并改写</el-button>
        <el-button type="danger" :loading="busy" @click="emit('confirm')">确认删除此段</el-button>
      </div>
    </template>
  </el-dialog>
</template>
<style scoped>
:global(.quality-delete-dialog.el-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 94dvh;
}
:global(.quality-delete-dialog .el-dialog__body) {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}
:global(.quality-delete-dialog .el-dialog__header),
:global(.quality-delete-dialog .el-dialog__footer) {
  flex-shrink: 0;
}
.delete-location {
  margin: 16px 0;
  color: var(--el-text-color-secondary);
  font-size: 14px;
}
.delete-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: stretch;
}
.delete-comparison section {
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
  min-width: 0;
}
.delete-comparison h4 {
  margin: 0;
  padding: 12px 16px;
  background: var(--el-fill-color-light);
  font-size: 14px;
}
.delete-comparison pre {
  margin: 0;
  padding: 16px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.85;
  height: min(28vh, 260px);
  overflow-y: auto;
  scrollbar-width: none;
}
.removed {
  color: var(--review-deleted-ink);
  background: var(--el-color-danger-light-9);
  text-decoration: line-through;
}
.duplicate-references {
  margin-top: 16px;
  font-size: 14px;
  max-height: 100px;
  overflow: auto;
}
.duplicate-references h4 {
  margin: 0 0 8px;
}
.duplicate-references p {
  margin: 6px 0;
}
.delete-note {
  margin-top: 16px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.delete-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex-wrap: wrap;
}
.delete-actions .el-button {
  margin: 0;
}
@media (max-width: 650px) {
  .delete-comparison {
    grid-template-columns: 1fr;
  }
}
</style>
