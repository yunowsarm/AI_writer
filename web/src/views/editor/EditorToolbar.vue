<script setup>
/** 编辑菜单：常用操作常驻，按真实容器宽度决定快捷项，其余操作统一收入更多。 */
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { EditPen, Check, RefreshLeft, RefreshRight, MoreFilled, ArrowDown, DocumentChecked, Document, Clock, Download } from '@element-plus/icons-vue'
const props = defineProps({ editor: Object, revision: Number, editing: Boolean, disabled: Boolean, saving: Boolean, hasEpisode: Boolean, reviewStatus: String, visibility: String })
const emit = defineEmits(['action'])
const root = ref(null),
  width = ref(800)
let observer
const actions = [
  { key: 'quality', label: '质量评估', icon: DocumentChecked },
  { key: 'versions', label: '版本记录', icon: Clock },
  { key: 'metadata', label: '剧本资料', icon: Document },
  { key: 'export', label: '导出', icon: Download }
]
const visibleCount = computed(() => Math.min(actions.length, Math.max(0, Math.floor((width.value - (props.editing ? 530 : 430)) / 115))))
const visible = computed(() => actions.slice(0, visibleCount.value))
const hidden = computed(() => actions.slice(visibleCount.value))
const canUndo = computed(() => {
  void props.revision
  return !props.disabled && !!props.editor?.can().undo()
})
const canRedo = computed(() => {
  void props.revision
  return !props.disabled && !!props.editor?.can().redo()
})

/** 工具操作保留当前文字选区，撤销/重做在阅读模式也能用于 AI 修改。 */
function command(key) {
  if (props.disabled) return
  // 切换编辑模式、保存和打开面板不聚焦正文，避免旧光标位于文末时触发自动滚动。
  if (!['undo', 'redo', 'bold', 'italic'].includes(key)) return emit('action', key)
  const chain = props.editor?.chain().focus()
  if (key === 'undo') chain?.undo().run()
  else if (key === 'redo') chain?.redo().run()
  else if (key === 'bold') chain?.toggleBold().run()
  else if (key === 'italic') chain?.toggleItalic().run()
}

onMounted(() => {
  observer = new ResizeObserver((entries) => {
    width.value = entries[0].contentRect.width
  })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())
</script>
<template>
  <div ref="root" class="editor-toolbar" role="toolbar" aria-label="剧本编辑菜单">
    <el-button class="edit-mode" :type="editing ? 'primary' : 'default'" :disabled="disabled || !hasEpisode" @mousedown.prevent @click="command('editing')">
      <el-icon><component :is="editing ? Check : EditPen" /></el-icon>
      <span>{{ editing ? '退出编辑' : '开始编辑' }}</span>
    </el-button>
    <div class="format-tools">
      <!-- <el-button class="icon-tool" title="撤销" aria-label="撤销" :disabled="!canUndo" @mousedown.prevent @click="command('undo')">
        <el-icon><RefreshLeft /></el-icon>
      </el-button>
      <el-button class="icon-tool" title="重做" aria-label="重做" :disabled="!canRedo" @mousedown.prevent @click="command('redo')">
        <el-icon><RefreshRight /></el-icon>
      </el-button> -->
      <template v-if="editing">
        <el-button class="icon-tool" :class="{ 'is-format-active': editor?.isActive('bold') }" title="加粗" aria-label="加粗" :disabled="disabled" @mousedown.prevent @click="command('bold')">
          <b>B</b>
        </el-button>
        <el-button class="icon-tool" :class="{ 'is-format-active': editor?.isActive('italic') }" title="斜体" aria-label="斜体" :disabled="disabled" @mousedown.prevent @click="command('italic')">
          <i>I</i>
        </el-button>
      </template>
    </div>
    <span class="toolbar-spacer"></span>
    <template v-for="item in visible" :key="item.key">
      <el-dropdown v-if="item.key === 'export'" trigger="click" :disabled="disabled" @command="command">
        <el-button :disabled="disabled">
          <el-icon><Download /></el-icon>
          导出
          <el-icon><ArrowDown /></el-icon>
        </el-button>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="export-copy">复制全文</el-dropdown-item>
            <el-dropdown-item command="export-md">导出 Markdown</el-dropdown-item>
            <el-dropdown-item command="export-txt">导出 TXT</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
      <el-button v-else :disabled="disabled || (!hasEpisode && item.key !== 'metadata')" @mousedown.prevent @click="command(item.key)">
        <el-icon><component :is="item.icon" /></el-icon>
        {{ item.label }}
      </el-button>
    </template>
    <el-button class="save-action" :loading="saving" :disabled="disabled || !hasEpisode" @mousedown.prevent @click="command('save')">保存</el-button>
    <el-dropdown trigger="click" @command="command">
      <el-button class="icon-tool more-action" aria-label="更多操作" title="更多操作">
        <el-icon><MoreFilled /></el-icon>
      </el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <template v-for="item in hidden" :key="item.key">
            <template v-if="item.key === 'export'">
              <el-dropdown-item command="export-copy" :disabled="disabled">复制全文</el-dropdown-item>
              <el-dropdown-item command="export-md" :disabled="disabled">导出 Markdown</el-dropdown-item>
              <el-dropdown-item command="export-txt" :disabled="disabled">导出 TXT</el-dropdown-item>
            </template>
            <el-dropdown-item v-else :command="item.key" :disabled="disabled || (!hasEpisode && item.key !== 'metadata')">{{ item.label }}</el-dropdown-item>
          </template>
          <el-dropdown-item v-if="editing" command="scene" divided :disabled="disabled">添加场景</el-dropdown-item>
          <el-dropdown-item v-if="editing" command="character" :disabled="disabled">添加人物</el-dropdown-item>
          <el-dropdown-item command="format" :disabled="disabled || !hasEpisode">格式标准化</el-dropdown-item>
          <el-dropdown-item command="publish" divided :disabled="disabled || !hasEpisode || reviewStatus === 'pending' || visibility === 'public'">
            {{ visibility === 'public' ? '已公开' : reviewStatus === 'pending' ? '审核中' : '提交公开审核' }}
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>
<style scoped>
.editor-toolbar {
  position: sticky;
  top: calc(var(--app-header-height, 73px) + 12px);
  z-index: 30;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 18px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--el-bg-color);
  box-shadow: 0 6px 24px rgb(50 35 80 / 8%);
}
.editor-toolbar .el-button {
  margin: 0;
  flex-shrink: 0;
  min-height: 38px;
  padding: 8px 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 7px;
  background: var(--el-bg-color);
  color: var(--el-text-color-regular);
  font-size: 14px;
  line-height: 20px;
  white-space: nowrap;
}
.editor-toolbar .el-button:hover {
  background: var(--el-color-primary-light-9);
  border-color: var(--el-color-primary-light-5);
  color: var(--purple);
}
.editor-toolbar .el-button--primary {
  background: var(--el-color-primary);
  border-color: var(--el-color-primary);
  color: #fff;
}
.editor-toolbar .el-button--primary:hover {
  background: var(--el-color-primary-light-3);
  color: #fff;
}
.editor-toolbar .is-disabled {
  opacity: 0.5;
}
.editor-toolbar .icon-tool {
  width: 36px;
  min-width: 36px;
  padding: 8px;
}
.format-tools {
  display: flex;
  gap: 4px;
}
.toolbar-spacer {
  flex: 1;
}
.editor-toolbar .is-format-active {
  color: var(--purple);
  background: var(--purple-light);
}
.editor-toolbar .el-icon + span {
  margin-left: 5px;
}
@media (max-width: 650px) {
  .editor-toolbar {
    flex-wrap: wrap;
    gap: 5px;
    padding: 8px;
  }
  .editor-toolbar .el-button {
    padding-inline: 8px;
  }
  .format-tools {
    gap: 2px;
  }
}
</style>
