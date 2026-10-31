<script setup>
/** 全局任务中心：后台进度、停止、完成通知与结果跳转。 */
import { ref, computed, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { ElNotification } from 'element-plus'
import { useAuth } from '../stores/auth'
import { useTasks } from '../stores/tasks'
import { api } from '../api/client'
import { reportError } from '../shared/feedback'
import { dateLabel } from '../shared/format'

const auth = useAuth(),
  tasks = useTasks(),
  router = useRouter()
const open = ref(false),
  stopping = ref(null)
const runningCount = computed(() => tasks.items.filter((t) => t.status === 'running').length)
const labels = {
  randomize: '随机故事设定',
  'append-episode': 'AI 续写分集',
  generate: '剧本生成',
  evaluate: '质量评估',
  optimize: '一键优化',
  continue: '续写',
  expand: '扩写',
  shorten: '精简',
  style: '风格改写',
  regenerate: '重新创作'
}
const statuses = { running: '进行中', completed: '已完成', failed: '失败', cancelled: '已停止' }
const percent = (task) => (task.status === 'completed' ? 100 : Math.min(99, Math.round(((task.progress?.completed || 0) / Math.max(1, task.progress?.total || 1)) * 100)))
let timer,
  seen = new Map()

/** 只通知当前会话中观察到的状态变化，不对历史任务重复弹窗。 */
async function refresh() {
  await tasks.refresh()
  for (const task of tasks.items) {
    if (seen.get(task.id) === 'running' && task.status !== 'running')
      ElNotification({
        title: (labels[task.operation] || 'AI 任务') + statuses[task.status],
        message: task.progress?.message || '可在任务中心查看结果',
        type: task.status === 'completed' ? 'success' : 'warning',
        duration: 7000,
        onClick: () => view(task)
      })
    seen.set(task.id, task.status)
  }
}

/** 完成评估进入报告；生成任务进入可观察的创作页，完成作品直接打开编辑器。 */
function view(task) {
  open.value = false
  const scriptId = task.progress?.scriptId || task.script_id
  if (task.operation === 'optimize' && scriptId) router.push({ path: '/scripts/' + scriptId, query: { optimization: task.id, opened: String(Date.now()) } })
  else if (task.operation === 'evaluate' && scriptId) router.push({ path: '/scripts/' + scriptId, query: { report: task.progress?.reportId || '', job: task.id } })
  else if (task.operation === 'generate')
    router.push(task.status === 'completed' && scriptId ? '/scripts/' + scriptId : { path: '/create', query: { job: task.id, ...(scriptId ? { resume: scriptId } : {}) } })
  else if (task.operation === 'append-episode' && scriptId) router.push({ path: '/scripts/' + scriptId, query: task.progress?.episodeId ? { episode: task.progress.episodeId } : {} })
  else if (scriptId) router.push('/scripts/' + scriptId)
  else if (task.operation === 'randomize' && task.status === 'completed') router.push({ path: '/create', query: { configuration: task.id } })
}

/** 只有显式点停止才取消上游；关闭抽屉与切换路由不影响任务。 */
async function stop(task) {
  stopping.value = task.id
  try {
    await api('/ai/jobs/' + task.id + '/cancel', { method: 'POST' })
    await refresh()
  } catch (e) {
    reportError(e)
  } finally {
    stopping.value = null
  }
}

watch(
  () => auth.user?.id,
  (id) => {
    clearInterval(timer)
    tasks.reset()
    seen = new Map()
    if (id) {
      refresh()
      timer = setInterval(refresh, 2500)
    }
  },
  { immediate: true }
)
onBeforeUnmount(() => clearInterval(timer))

/** 打开面板并立即同步最新状态。 */
function showCenter() {
  open.value = true
  refresh()
}
</script>

<template>
  <el-badge v-if="auth.user" :value="runningCount" :hidden="!runningCount">
    <el-button class="task-center-trigger" @click="showCenter">
      <el-icon><Clock /></el-icon>
      任务中心
    </el-button>
  </el-badge>
  <!-- 挂载到 body，避免悬浮顶栏的 backdrop-filter 把 fixed 遮罩和抽屉限制在顶栏内。 -->
  <el-drawer v-model="open" title="任务中心" size="min(100%, 480px)" append-to-body>
    <p class="task-note">生成与评估可在后台运行。关闭面板、切换页面或刷新浏览器都不会停止任务；关闭后端服务会中断任务。</p>
    <el-alert v-if="tasks.error" :title="tasks.error" type="warning" :closable="false" />
    <el-empty v-if="!tasks.items.length" description="暂无 AI 任务" />
    <article v-for="task in tasks.items" :key="task.id" class="background-task">
      <div class="task-title">
        <b>{{ labels[task.operation] || task.operation }}</b>
        <el-tag size="small" :type="task.progress?.resultStatus === 'partial' ? 'warning' : task.status === 'completed' ? 'success' : task.status === 'running' ? 'primary' : 'info'">
          {{ task.progress?.resultStatus === 'partial' ? '部分完成' : statuses[task.status] }}
        </el-tag>
      </div>
      <h4 v-if="task.progress?.title">{{ task.progress.title }}</h4>
      <p>{{ task.progress?.message || task.model }}</p>
      <el-progress v-if="['generate', 'evaluate', 'optimize', 'append-episode'].includes(task.operation)" :percentage="percent(task)" :stroke-width="5" />
      <small>{{ task.model }} · {{ dateLabel(task.created_at) }}</small>
      <div class="task-actions">
        <el-button size="small" @click="view(task)">{{ task.status === 'running' ? '查看进度' : '查看结果' }}</el-button>
        <el-button v-if="task.status === 'running'" size="small" :loading="stopping === task.id" @click="stop(task)">停止任务</el-button>
      </div>
    </article>
  </el-drawer>
</template>

<style scoped>
.task-center-trigger .el-icon {
  margin-right: 6px;
}
.task-note {
  font-size: 14px;
  line-height: 1.8;
  color: var(--el-text-color-secondary);
  margin-bottom: 20px;
}
.background-task {
  min-width: 0;
  overflow-wrap: anywhere;
  padding: 20px 0;
  border-bottom: 1px solid var(--line);
}
.task-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.background-task p {
  font-size: 14px;
  line-height: 1.8;
  margin: 12px 0;
}
.background-task small {
  color: var(--el-text-color-secondary);
  display: block;
  margin-top: 12px;
}
.task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 14px;
}
.task-actions .el-button + .el-button {
  margin-left: 0;
}
</style>
