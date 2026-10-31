<script setup>
/** 新分集入口：空白页立即创建；AI 续写接收剧情走向并作为后台任务执行。 */
import { ref, watch, onBeforeUnmount } from 'vue'
import { api } from '../../api/client'
import { useTasks } from '../../stores/tasks'
import { reportError, success } from '../../shared/feedback'
import ModelSelector from '../../components/ModelSelector.vue'
const props = defineProps({ script: Object, save: Function })
const emit = defineEmits(['added'])
const tasks = useTasks()
const open = ref(false),
  mode = ref('blank'),
  title = ref(''),
  direction = ref(''),
  selection = ref(),
  creating = ref(false),
  job = ref(null),
  message = ref('')
let active = true,
  polling = false
onBeforeUnmount(() => {
  active = false
})

/** 再次打开进行中的任务时保留参数，避免误创建重复分集。 */
function show() {
  if (!creating.value) {
    mode.value = 'blank'
    direction.value = ''
    message.value = ''
    title.value = '第 ' + ((props.script.episodes.at(-1)?.episode_no || 0) + 1) + ' 集'
  }
  open.value = true
}

/** 创建前先保存当前编辑；后台续写不阻塞用户关闭弹窗或切换页面。 */
async function create() {
  if (creating.value) return
  if (!title.value.trim() || (mode.value === 'ai' && direction.value.trim().length < 2)) return reportError(new Error('请填写分集名称；AI 续写还需填写剧情走向'))
  creating.value = true
  const scriptId = props.script.id
  try {
    await props.save('添加分集前保存')
    if (mode.value === 'blank') {
      const result = await api('/scripts/' + scriptId + '/episodes', { method: 'POST', body: { title: title.value } })
      emit('added', { scriptId, episodeId: result.id })
      open.value = false
      creating.value = false
    } else {
      const result = await api('/ai/scripts/' + scriptId + '/episodes', { method: 'POST', body: { title: title.value, direction: direction.value, selection: selection.value } })
      job.value = { id: result.jobId, scriptId }
      message.value = '正在后台续写，可关闭弹窗，从任务中心查看进度。'
      await tasks.refresh()
    }
  } catch (e) {
    creating.value = false
    reportError(e)
  }
}

/** 任务摘要只在状态变化后读取详情，成功后定位新分集，失败不创建空占位页。 */
async function sync() {
  if (!job.value || polling) return
  const current = job.value
  const task = tasks.items.find((t) => t.id === current.id)
  if (!task || task.status === 'running') return
  polling = true
  try {
    const result = await api('/ai/jobs/' + current.id)
    if (!active) return
    job.value = null
    creating.value = false
    if (result.status === 'completed') {
      const episodeId = result.progress?.episodeId || JSON.parse(result.output).episodeId
      emit('added', { scriptId: current.scriptId, episodeId })
      open.value = false
      success('AI 新分集已生成并保存')
    } else message.value = result.progress?.message || '续写未完成，原剧本保持不变，可调整后重试'
  } catch (e) {
    if (active) reportError(e)
  } finally {
    polling = false
  }
}
watch(() => tasks.revision, sync)
defineExpose({ show })
</script>

<template>
  <el-dialog v-model="open" title="添加分集" width="min(94vw, 620px)" append-to-body>
    <el-form label-position="top" :disabled="creating">
      <el-form-item label="创建方式">
        <el-radio-group v-model="mode">
          <el-radio-button value="blank">添加空白页</el-radio-button>
          <el-radio-button value="ai">AI 续写分集</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="分集名称"><el-input v-model="title" maxlength="120" /></el-form-item>
      <template v-if="mode === 'ai'">
        <el-form-item label="使用模型"><ModelSelector v-model="selection" :disabled="creating" /></el-form-item>
        <el-form-item label="剧情走向">
          <el-input v-model="direction" type="textarea" :rows="5" maxlength="3000" show-word-limit placeholder="例如：主角找到关键证人，对手试图销毁证据，结尾留下身份反转。" />
        </el-form-item>
        <p class="episode-hint">结合当前设定、大纲及最近分集续写一集，生成成功后自动保存。已公开的内容仍保留原审核版本。</p>
      </template>
    </el-form>
    <el-alert v-if="message" :title="message" type="info" :closable="false" />
    <template #footer>
      <el-button @click="open = false">{{ creating ? '后台运行，关闭' : '取消' }}</el-button>
      <el-button type="primary" :loading="creating" @click="create">{{ mode === 'ai' ? '开始 AI 续写' : '创建空白分集' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.episode-hint {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.8;
  margin-bottom: 16px;
}
</style>
