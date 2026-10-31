<script setup>
/** 灵感助手：先选择操作与范围，再生成候选；应用时核对当前文档与版本。 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { Right, ZoomIn, Scissor, Brush, Refresh } from '@element-plus/icons-vue'
import { api, streamApi } from '../../api/client'
import { reportError } from '../../shared/feedback'
import { escapeHtml } from './document'
import ModelSelector from '../../components/ModelSelector.vue'
import { rewriteBudget } from '../../../../shared/rewriteLength.js'

const props = defineProps({ editor: Object, episode: Object, save: Function, enabled: Boolean, disabled: Boolean })
const emit = defineEmits(['applied', 'busy', 'dismissed'])
const selectionModel = ref(),
  open = ref(false),
  busy = ref(false),
  output = ref(''),
  error = ref('')
const operation = ref('expand'),
  style = ref('更有冲突感'),
  instruction = ref(''),
  scope = ref('episode')
const selectionSize = ref(0),
  sourceText = ref(''),
  context = ref(null)
const operations = [
  { key: 'continue', title: '续写情节', desc: '从当前段落延续下一幕', icon: Right },
  { key: 'expand', title: '扩写细节', desc: '丰富动作、环境和情绪', icon: ZoomIn },
  { key: 'shorten', title: '精简表达', desc: '保留信息，让节奏更利落', icon: Scissor },
  { key: 'style', title: '改写风格', desc: '按指定风格重新表达', icon: Brush },
  { key: 'regenerate', title: '重新创作', desc: '保留设定，尝试另一种写法', icon: Refresh }
]
const currentOperation = computed(() => operations.find((a) => a.key === operation.value))
const targetWords = ref(null)
const scopeText = computed(() => {
  if (!range || !props.editor) return ''
  return scope.value === 'episode' ? props.editor.getText() : props.editor.state.doc.textBetween(range.from, range.to, '\n')
})
const budget = computed(() => rewriteBudget(sourceText.value || scopeText.value, operation.value, targetWords.value || undefined))
const outputSize = computed(() => Array.from(output.value.replace(/\s/g, '')).length)
const oversized = computed(() => outputSize.value > budget.value.max * 1.3)
/** 修改篇幅后废弃旧候选，必须按新要求重新生成。 */
function resetCandidate() {
  output.value = ''
  error.value = ''
}
let range = null,
  selection = null,
  controller = null,
  jobId = null,
  appliedDuringClose = false

/** 跟踪选区长度，始终让处理范围在发起请求前可见。 */
function updateSelection() {
  const { from, to } = props.editor.state.selection
  selectionSize.value = from === to ? 0 : props.editor.state.doc.textBetween(from, to, '\n').length
}

watch(
  () => props.editor,
  (editor, old) => {
    old?.off('selectionUpdate', updateSelection)
    editor?.on('selectionUpdate', updateSelection)
    if (editor) updateSelection()
  },
  { immediate: true }
)
onBeforeUnmount(() => props.editor?.off('selectionUpdate', updateSelection))
// 更改处理范围立即更新原文和字数提示；生成后范围被冻结。
watch(scope, () => {
  if (!range || busy.value || output.value) return
  sourceText.value = scope.value === 'episode' ? props.editor.getText() : props.editor.state.doc.textBetween(range.from, range.to, '\n')
})

/** 点击操作只打开设置，不立即产生模型调用；固定当前选区以免弹窗焦点改变范围。 */
function prepare(key) {
  if (!props.episode || busy.value || props.disabled) return false
  const { from, to } = props.editor.state.selection
  range = { from, to, episodeId: props.episode.id, hasSelection: from !== to }
  scope.value = range.hasSelection ? 'selection' : 'episode'
  operation.value = key
  instruction.value = ''
  context.value = null
  output.value = ''
  error.value = ''
  sourceText.value = scope.value === 'episode' ? props.editor.getText() : props.editor.state.doc.textBetween(from, to, '\n')
  targetWords.value = null
  appliedDuringClose = false
  open.value = true
  return true
}

/** 保存后固定正文、版本和选区；流式返回只作为候选，完成前不能应用。 */
async function start() {
  if (busy.value || props.disabled) return
  if (!selectionModel.value) return reportError(new Error('请先选择可用模型'))
  busy.value = true
  emit('busy', true)
  output.value = ''
  error.value = ''
  try {
    await props.save('AI 修改前')
    if (props.episode.id !== range.episodeId) throw new Error('分集已变化，请重新选择操作')
    const full = scope.value === 'episode'
    sourceText.value = full ? props.editor.getText() : props.editor.state.doc.textBetween(range.from, range.to, '\n')
    if (!sourceText.value.trim()) throw new Error('请先写入或选中需要处理的内容')
    selection = { ...range, full, revision: props.episode.revision, document: JSON.stringify(props.editor.getJSON()) }
    controller = new AbortController()
    let terminal = false
    await streamApi(
      '/ai/rewrite',
      {
        episodeId: selection.episodeId,
        revision: selection.revision,
        operation: operation.value,
        text: sourceText.value,
        style: style.value,
        instruction: instruction.value.slice(0, 1000),
        targetWords: targetWords.value || undefined,
        selection: selectionModel.value
      },
      (event, data) => {
        if (event === 'start') jobId = data.jobId
        if (event === 'delta') output.value += data.text
        if (event === 'error' || event === 'cancelled') {
          error.value = data.message || '任务已停止'
          terminal = true
        }
        if (event === 'done') terminal = true
      },
      controller.signal
    )
    if (!terminal) error.value = '候选未完整返回，请重新生成'
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
    emit('busy', false)
  }
}

/** 停止只取消候选生成，原文不会发生变化。 */
async function stop() {
  try {
    if (jobId) await api('/ai/jobs/' + jobId + '/cancel', { method: 'POST' })
  } catch (e) {
    reportError(e)
  }
}

/** 应用前再次核对文档，替换/续写成功后保存为新版本并将建议上下文交回报告。 */
async function apply() {
  try {
    if (!selection || props.episode.id !== selection.episodeId || props.episode.revision !== selection.revision || JSON.stringify(props.editor.getJSON()) !== selection.document)
      throw new Error('正文已变化，请重新生成候选，以免覆盖修改')
    const html = output.value
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => '<p>' + escapeHtml(line) + '</p>')
      .join('')
    if (operation.value === 'continue')
      props.editor
        .chain()
        .focus()
        .insertContentAt(selection.full ? props.editor.state.doc.content.size : selection.to, html)
        .run()
    else if (selection.full) props.editor.commands.setContent(html)
    else props.editor.chain().focus().insertContentAt({ from: selection.from, to: selection.to }, html).run()
    await props.save('应用 AI ' + currentOperation.value.title)
    appliedDuringClose = true
    open.value = false
    emit('applied', context.value)
  } catch (e) {
    reportError(e)
  }
}

/** 从评估建议直接发起定向候选，并保留报告位置供应用或放弃后返回。 */
async function optimize(value, sourceContext) {
  if (!prepare('regenerate')) return
  instruction.value = value.slice(0, 1000)
  context.value = sourceContext
  await start()
}

/** 关闭候选后返回原建议列表，未应用不标记为已处理。 */
function afterClose() {
  if (!appliedDuringClose) emit('dismissed', context.value)
  context.value = null
}

defineExpose({ isBusy: () => busy.value, stop, optimize })
</script>

<template>
  <aside class="ai-assist panel assistant-redesign">
    <label class="assistant-label">使用模型</label>
    <ModelSelector v-model="selectionModel" :disabled="busy || disabled" />
    <div class="assistant-scope">
      <span class="scope-dot"></span>
      {{ selectionSize ? '已选中 ' + selectionSize + ' 字' : '未选中文字 · 默认处理整集' }}
    </div>
    <div class="assistant-operations">
      <button v-for="action in operations" :key="action.key" class="operation-card" :disabled="!enabled || disabled || busy" @mousedown.prevent @click="prepare(action.key)">
        <span class="operation-icon">
          <el-icon><component :is="action.icon" /></el-icon>
        </span>
        <span class="operation-copy">
          <b>{{ action.title }}</b>
          <small>{{ action.desc }}</small>
        </span>
        <el-icon class="operation-arrow"><ArrowRight /></el-icon>
      </button>
    </div>
    <p class="assistant-note">{{ enabled ? '选择操作后确认范围，生成候选预览；应用后自动保存新版本。' : '先在 API 配置中启用模型。' }}</p>
  </aside>
  <el-dialog
    v-model="open"
    :title="currentOperation.title + ' · 修改候选'"
    width="min(94vw, 920px)"
    class="candidate-dialog"
    top="5vh"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @closed="afterClose">
    <p class="candidate-intro">{{ currentOperation.desc }}。对比原文与候选，确认满意后再应用。</p>
    <div class="candidate-settings">
      <el-form label-position="top" :disabled="busy">
        <el-form-item label="处理范围">
          <el-radio-group v-model="scope" :disabled="!!output">
            <el-radio-button value="selection" :disabled="!range?.hasSelection">选中文字</el-radio-button>
            <el-radio-button value="episode">当前整集</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="operation === 'style'" label="目标风格"><el-input v-model="style" maxlength="100" placeholder="例如：黑色幽默、冲突更强" /></el-form-item>
        <el-form-item label="目标字数（可选）">
          <el-input-number v-model="targetWords" :min="10" :max="12000" :step="10" placeholder="自动" @change="resetCandidate" />
          <p class="length-hint">原文 {{ budget.source }} 字 · 建议 {{ budget.min }}–{{ budget.max }} 字</p>
        </el-form-item>
        <el-form-item label="补充要求（可选）">
          <el-input v-model="instruction" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="说明需要保留的事实，或希望重点调整的内容" />
        </el-form-item>
      </el-form>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-alert v-if="oversized" :title="`候选约 ${outputSize} 字，超出建议的 ${budget.min}–${budget.max} 字。篇幅仅供参考，确认内容合适后仍可直接应用。`" type="warning" :closable="false" />
    <div v-if="sourceText || output" class="candidate-comparison">
      <section>
        <h4>
          <span>
            原文
            <small>保留备份</small>
          </span>
          <span class="candidate-count">{{ budget.source }} 字</span>
        </h4>
        <div>{{ sourceText }}</div>
      </section>
      <section>
        <h4>
          <span>
            {{ busy ? '正在生成候选…' : '修改候选' }}
            <small>{{ error ? '未完成' : busy ? '实时更新' : output ? '待确认' : '尚未生成' }}</small>
          </span>
          <span class="candidate-count">{{ outputSize }} 字</span>
        </h4>
        <div aria-live="polite">{{ output || (busy ? '等待模型返回…' : '点击“生成候选”后在这里预览修改') }}</div>
      </section>
    </div>
    <template #footer>
      <div class="candidate-actions">
        <el-button v-if="busy" @click="stop">停止生成</el-button>
        <template v-else>
          <el-button @click="open = false">{{ output ? '放弃修改' : '取消' }}</el-button>
          <el-button :loading="busy" @click="start">{{ output ? '重新生成候选' : '生成候选' }}</el-button>
          <el-button v-if="output" type="primary" :disabled="!!error" @click="apply">{{ operation === 'continue' ? '插入续写内容' : '确认应用修改' }}</el-button>
        </template>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
/* 控制弹窗总高度，内容独立滚动，较矮窗口也能始终看到确认与取消按钮。 */
:global(.candidate-dialog.el-dialog) {
  max-height: 94dvh;
  display: flex;
  flex-direction: column;
}
:global(.candidate-dialog .el-dialog__body) {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  scrollbar-width: none;
}
:global(.candidate-dialog .el-dialog__header),
:global(.candidate-dialog .el-dialog__footer) {
  flex-shrink: 0;
}
.assistant-redesign {
  position: sticky;
  top: calc(var(--app-header-height, 73px) + 90px);
  padding: 20px 16px !important;
  border-radius: 12px;
}
.assistant-heading {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 22px;
}
.assistant-heading h3 {
  font-size: 15px;
}
.assistant-heading p {
  color: var(--el-text-color-secondary);
  font-size: 13px;
  margin-top: 5px;
}
.assistant-mark {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--purple-light);
  color: var(--purple);
  font-size: 20px;
}
.assistant-label {
  display: block;
  font-size: 14px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.assistant-scope {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin: 14px 0;
}
.scope-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--purple);
}
.assistant-operations {
  display: grid;
  gap: 8px;
}
.operation-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--line);
  border-radius: 9px;
  padding: 12px 10px;
  background: var(--el-bg-color);
}
.operation-card:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}
.operation-card:disabled {
  opacity: 0.5;
}
.operation-icon {
  display: grid;
  place-items: center;
  flex: 0 0 28px;
  height: 30px;
  color: var(--purple);
  background: var(--purple-light);
  border-radius: 7px;
  font-size: 17px;
}
.operation-copy {
  flex: 1;
}
.operation-copy b {
  font-size: 14px;
  font-weight: 500;
}
.operation-copy small {
  font-size: 13px !important;
  margin-top: 5px !important;
  line-height: 1.6;
  color: var(--el-text-color-secondary) !important;
}
.operation-arrow {
  font-size: 14px;
  color: var(--el-text-color-placeholder);
}
.assistant-note {
  font-size: 13px !important;
  line-height: 1.8;
  margin: 18px 0 0 !important;
  color: var(--el-text-color-secondary) !important;
}
.candidate-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: stretch;
}
.candidate-comparison section {
  margin: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 9px;
  overflow: hidden;
}
.candidate-comparison h4 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 46px;
  padding: 12px 16px;
  font-size: 14px;
  background: var(--el-fill-color-light);
  margin: 0;
}
.candidate-comparison section > div {
  white-space: pre-wrap;
  line-height: 1.9;
  font-size: 16px;
  padding: 16px;
  height: clamp(180px, 34vh, 360px);
  overflow: auto;
  scrollbar-width: none;
}
.candidate-intro {
  margin: 0 0 20px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.candidate-settings :deep(.el-form) {
  display: grid;
  grid-template-columns: minmax(210px, 0.8fr) minmax(0, 2fr);
  gap: 0 20px;
}
.candidate-settings :deep(.el-form-item:last-child) {
  grid-column: 2;
  grid-row: 1 / span 3;
}
.length-hint {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}
.candidate-settings :deep(.el-textarea__inner) {
  padding-bottom: 22px;
  line-height: 1.7;
}
.candidate-comparison h4 small {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
  font-weight: 400;
}
.candidate-count {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  font-weight: 400;
  white-space: nowrap;
}
.candidate-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  flex-wrap: wrap;
  border-top: 1px solid var(--line);
  padding-top: 18px;
}
.candidate-actions .el-button {
  margin: 0;
}
@media (max-width: 800px) {
  .assistant-redesign {
    position: static;
  }
  .candidate-comparison {
    grid-template-columns: 1fr;
  }
  .candidate-settings :deep(.el-form) {
    display: block;
  }
}
</style>
