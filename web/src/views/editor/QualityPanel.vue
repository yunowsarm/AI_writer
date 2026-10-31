<script setup>
/** 剧本评估面板：实时任务进度、历史报告、证据定位和由作者确认的定向优化。 */
import { ref, computed, nextTick, watch } from 'vue'
import { api } from '../../api/client'
import { reportError } from '../../shared/feedback'
import { dateLabel } from '../../shared/format'
import ModelSelector from '../../components/ModelSelector.vue'
import { useTasks } from '../../stores/tasks'
import QualityCharts from './QualityCharts.vue'
import { remainingEvidence, qualityActionKind } from '../../../../shared/qualityResolution.js'
import QualityOptimizer from './QualityOptimizer.vue'

const props = defineProps({ scriptId: Number, save: Function, disabled: Boolean })
const emit = defineEmits(['busy', 'locate', 'optimize', 'optimization-applied'])
const optimizer = ref(null)
const open = ref(false),
  running = ref(false),
  loading = ref(false),
  selection = ref(),
  reports = ref([]),
  report = ref(null)
const phase = ref(''),
  progress = ref(0),
  jobId = ref(),
  dimension = ref('all'),
  error = ref('')
const tasks = useTasks()
const hideResolved = ref(true)
const hideIgnored = ref(true),
  ignoring = ref(null)
const sortOrder = ref('priority')
const severityRank = { critical: 0, major: 1, minor: 2 }
const severityTags = { critical: { label: '严重', type: 'danger' }, major: { label: '较重要', type: 'warning' }, minor: { label: '轻微', type: 'primary' } }
const statusLabel = { running: '评估中', completed: '已完成', partial: '部分完成', cancelled: '已停止', failed: '失败' }
const issues = computed(() =>
  (report.value?.result?.issues || [])
    .map((i) => ({ ...i, evidence: hideResolved.value ? remainingEvidence(i, report.value.resolvedEvidence) : i.evidence }))
    .filter((i) => dimension.value === 'all' || i.dimension === dimension.value)
    .filter((i) => !hideResolved.value || !report.value.resolvedIssues?.includes(i.id))
    .filter((i) => !hideIgnored.value || !report.value.ignoredIssues?.includes(i.id))
    .sort((a, b) =>
      sortOrder.value === 'priority'
        ? Number(!!a.advisory) - Number(!!b.advisory) || (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3) || Number(!!a.needsConfirmation) - Number(!!b.needsConfirmation)
        : 0
    )
)
const previous = ref(null)

/** 忽略仅影响当前报告的待办和优化范围；刷新后保留，恢复后可继续处理，不伪造评分提升。 */
async function toggleIgnore(issue) {
  const id = report.value.id
  ignoring.value = issue.id
  try {
    await api('/quality/reports/' + id + '/issues/' + issue.id + '/ignore', { method: 'POST', body: { ignored: !report.value.ignoredIssues?.includes(issue.id) } })
    const latest = await api('/quality/reports/' + id)
    if (report.value?.id === id) report.value = latest
  } catch (e) {
    reportError(e)
  } finally {
    ignoring.value = null
  }
}
const pendingAction = ref(null)
const difference = computed(() => (report.value?.result?.total != null && previous.value?.result?.total != null ? report.value.result.total - previous.value.result.total : null))

/** 进入前保存正文，报告列表的过期判断才对应当前内容。 */
async function show(reportId) {
  try {
    await props.save('质量评估前保存')
    open.value = true
    await load(reportId)
    await tasks.refresh()
    const active = tasks.items.find((t) => t.operation === 'evaluate' && t.status === 'running' && (t.script_id === props.scriptId || t.progress?.scriptId === props.scriptId))
    if (active) {
      jobId.value = active.id
      running.value = true
      syncTask()
    }
  } catch (e) {
    reportError(e)
  }
}

/** 获取历史报告，并打开最近一次结果。 */
async function load(reportId) {
  loading.value = true
  try {
    reports.value = await api('/quality/scripts/' + props.scriptId + '/reports')
    if (reports.value.length) await selectReport(reportId || report.value?.id || reports.value[0].id)
    else report.value = null
  } catch (e) {
    reportError(e)
  } finally {
    loading.value = false
  }
}

/** 只将同算法、同供应商和模型的完整旧报告用于前后分数比较。 */
async function selectReport(id) {
  try {
    report.value = await api('/quality/reports/' + id)
    previous.value = null
    const current = report.value
    const candidates = reports.value.filter(
      (r) =>
        r.status === 'completed' &&
        r.id !== id &&
        r.created_at < current.created_at &&
        r.algorithm_version === current.algorithm_version &&
        r.model === current.model &&
        r.provider_name === current.provider_name
    )
    for (const prior of candidates) {
      const value = await api('/quality/reports/' + prior.id)
      if (current.result?.evaluator && current.result.evaluator === value.result?.evaluator && current.result.scoring?.standard === value.result.scoring?.standard) {
        previous.value = value
        break
      }
    }
  } catch (e) {
    reportError(e)
  }
}

/** 分块完成数来自服务端事件；没有完成全部分析时不展示伪造总分。 */
async function evaluate() {
  if (!selection.value) return reportError(new Error('请先选择评估模型'))
  running.value = true
  emit('busy', true)
  error.value = ''
  progress.value = 0
  phase.value = '正在准备评估快照'
  try {
    await props.save('质量评估前保存')
    const task = await api('/quality/scripts/' + props.scriptId + '/evaluate', { method: 'POST', body: { selection: selection.value, background: true } })
    if (task.cached) {
      running.value = false
      jobId.value = null
      progress.value = 100
      phase.value = '已复用完整报告'
      await load(task.reportId)
    } else {
      jobId.value = task.jobId
      await tasks.refresh()
      syncTask()
    }
  } catch (e) {
    error.value = e.message
    running.value = false
  } finally {
    emit('busy', running.value)
  }
}

/** 取消任务由统一 AI 接口处理，已完成的分析随报告保留。 */
async function stop() {
  try {
    if (jobId.value) await api('/ai/jobs/' + jobId.value + '/cancel', { method: 'POST' })
  } catch (e) {
    reportError(e)
  }
}

/** 关闭抽屉后交给编辑器检查快照，定位证据或生成可预览的修改候选。 */
async function action(type, value) {
  pendingAction.value = { type, payload: { value, snapshot: report.value.snapshot, reportId: report.value.id } }
  open.value = false
}

/** 抽屉完全关闭并解除页面滚动锁后再定位，避免关闭动画把页面恢复到旧滚动位置。 */
async function runPendingAction() {
  const pending = pendingAction.value
  pendingAction.value = null
  if (!pending) return
  await nextTick()
  emit(pending.type, pending.payload)
}

/** 从全局任务状态更新评估进度；关闭报告不会取消评估。 */
async function syncTask() {
  if (!jobId.value) return
  const task = tasks.items.find((t) => t.id === jobId.value)
  if (!task) return
  phase.value = task.progress?.message || '正在后台评估'
  progress.value = task.status === 'completed' ? 100 : Math.min(99, Math.round(((task.progress?.completed || 0) / Math.max(1, task.progress?.total || 1)) * 100))
  running.value = task.status === 'running'
  emit('busy', running.value)
  if (!running.value) {
    jobId.value = null
    if (task.status !== 'completed') error.value = task.progress?.message || '评估未完成'
    await load(task.progress?.reportId)
  }
}

/** 应用某条建议后只标记该条，其他原文仍可独立校验和继续处理。 */
async function markApplied(reportId, issueId, paragraphId) {
  await api('/quality/reports/' + reportId + '/issues/' + issueId + '/resolve', { method: 'POST', body: { paragraphId } })
  await show(reportId)
}

watch(() => tasks.revision, syncTask)
/** 按整份报告处理未完成位置，独立于当前维度筛选。 */
async function optimizeAll() {
  if (!report.value) return
  open.value = false
  await nextTick()
  await optimizer.value.show(report.value.id, selection.value)
}

/** 从任务中心恢复后台候选。 */
async function showOptimization(id) {
  open.value = false
  await nextTick()
  await optimizer.value.showJob(id)
}

/** 同步处理状态，并通知编辑器重新读取正文。 */
async function optimizationApplied(info) {
  emit('optimization-applied', info)
  await load(info.reportId)
}

defineExpose({ show, markApplied, showOptimization })
</script>

<template>
  <el-drawer v-model="open" title="剧本质量评估" size="min(100%, 1040px)" :close-on-click-modal="true" :close-on-press-escape="true" :show-close="true" destroy-on-close @closed="runPendingAction">
    <div class="quality-controls">
      <ModelSelector v-model="selection" :disabled="running" />
      <el-button type="primary" :disabled="(disabled && !running) || !selection" :loading="running" @click="evaluate">{{ report ? '重新评估当前剧本' : '开始评估' }}</el-button>
      <el-button v-if="report?.result" type="primary" :disabled="running || disabled" @click="optimizeAll">一键优化</el-button>
      <el-button v-if="running" @click="open = false">后台评估</el-button>
      <el-button v-if="running" @click="stop">停止评估</el-button>
    </div>
    <p class="quality-note">评估可在后台运行，关闭面板后可从右上角任务中心查看进度。相同内容与模型的完整报告会自动复用。</p>
    <div v-if="running || phase" class="quality-progress">
      <p>{{ phase }}</p>
      <el-progress :percentage="progress" :stroke-width="5" />
    </div>
    <el-alert v-if="error" :title="error" type="warning" :closable="false" />
    <div v-loading="loading">
      <div v-if="reports.length" class="history-row">
        <span>历史报告</span>
        <el-select :model-value="report?.id" :disabled="running" @change="selectReport">
          <el-option v-for="r in reports" :key="r.id" :value="r.id" :label="dateLabel(r.created_at) + ' · ' + r.model + ' · ' + statusLabel[r.status] + (r.stale ? ' · 旧稿' : '')" />
        </el-select>
      </div>
      <el-empty v-if="!report && !running" description="还没有质量报告，选择模型开始分析" />
      <template v-if="report">
        <el-alert v-if="!report.result?.scoring" title="这是旧版自由评分报告。重新评估将使用固定证据量表，新旧版本分数不直接比较；历史报告与原稿均保留。" type="info" :closable="false" />
        <el-alert v-if="report.stale" title="剧本已更新，评分对应评估时的稿件。未修改的段落仍可逐项优化；原文已改动或位置无法确认时会提示重新选择。" type="warning" :closable="false" />
        <div class="quality-score panel">
          <div>
            <span>综合评分</span>
            <strong>
              {{ report.result?.total ?? '—' }}
              <small v-if="report.result?.total != null">/ 100</small>
            </strong>
            <p>{{ statusLabel[report.status] }} · {{ report.provider_name }} / {{ report.model }}</p>
            <p v-if="difference !== null">较上次同标准评估 {{ difference > 0 ? '+' : '' }}{{ difference }} 分</p>
          </div>
          <div class="dimension-list">
            <div v-for="d in report.result?.dimensions || []" :key="d.key">
              <span>
                {{ d.label }}
                <small>{{ Math.round(d.weight * 100) }}%</small>
              </span>
              <b>{{ d.score ?? '未完成' }}</b>
            </div>
          </div>
        </div>
        <p class="quality-note" v-if="report.result?.scoring">
          {{ report.algorithm_version }} · 每维从 100 分起，轻微 / 较重要 / 严重问题分别扣 2 / 6 / 12
          分；同一集内多处证据分摊，同维度同位置取最重扣分，各集等权平均后按维度权重汇总。时长与创作偏好仅提示，待确认问题不扣分。未发现问题不代表艺术水平满分。
        </p>
        <p class="quality-note" v-else>{{ report.algorithm_version }} · 旧版规则检查与 AI 自由评分，建议重新评估。</p>
        <details v-if="report.result?.scoring" class="quality-scoring">
          <summary>查看扣分依据（{{ report.result.scoring.deductions.length }} 组）</summary>
          <p v-if="!report.result.scoring.deductions.length">本次未发现进入计分的明确问题，创作建议仍可查看下方列表。</p>
          <p v-for="(deduction, index) in report.result.scoring.deductions" :key="index">
            第 {{ report.snapshot.episodes.find((e) => e.id === deduction.episodeId)?.episode_no }} 集 · {{ report.result.dimensions.find((d) => d.key === deduction.dimension)?.label }}：扣
            {{ Number(deduction.points.toFixed(2)) }} 分（该集维度内）；{{
              deduction.issueIds
                .map((id) => report.result.issues.find((i) => i.id === id)?.title)
                .filter(Boolean)
                .join('、')
            }}
          </p>
        </details>
        <p v-if="report.result?.coverage.reusedChunks" class="quality-note">已复用 {{ report.result.coverage.reusedChunks }} 块相同输入的分析，未改动部分沿用同一结论。</p>
        <template v-if="report.result">
          <QualityCharts :result="report.result" />
          <el-alert v-for="(failure, i) in report.result.errors" :key="i" :title="(failure.episodeNo ? '第 ' + failure.episodeNo + ' 集：' : '') + failure.message" type="warning" :closable="false" />
          <div class="panel-heading issue-heading">
            <h3>评估建议（{{ issues.length }}）</h3>
            <el-switch v-model="hideResolved" active-text="隐藏已处理" />
            <el-switch v-model="hideIgnored" :active-text="'隐藏已忽略（' + (report.ignoredIssues?.length || 0) + '）'" />
            <el-select v-model="sortOrder" aria-label="建议排序">
              <el-option value="priority" label="重要程度优先" />
              <el-option value="original" label="报告原始顺序" />
            </el-select>
            <el-select v-model="dimension">
              <el-option value="all" label="全部维度" />
              <el-option v-for="d in report.result.dimensions" :key="d.key" :value="d.key" :label="d.label" />
            </el-select>
          </div>
          <el-empty v-if="!issues.length" description="当前范围没有发现可引用证据的问题" :image-size="70" />
          <p v-if="report.ignoredIssues?.length" class="quality-note">已忽略的问题不参与一键优化。关闭“隐藏已忽略”后可恢复；忽略不代表问题已解决，不改变本报告评分，仅对本次报告生效。</p>
          <article v-for="issue in issues" :key="issue.id" class="quality-issue">
            <div class="issue-title">
              <h4>{{ issue.title }}</h4>
              <el-tag v-if="report.ignoredIssues?.includes(issue.id)" type="info" size="small">已忽略</el-tag>
              <el-button text :loading="ignoring === issue.id" :disabled="running || !!ignoring" @click="toggleIgnore(issue)">
                {{ report.ignoredIssues?.includes(issue.id) ? '恢复问题' : '忽略问题' }}
              </el-button>
              <el-tag v-if="report.resolvedIssues?.includes(issue.id)" type="success" size="small">已处理</el-tag>
              <el-tag v-if="issue.advisory" size="small" type="info">仅提示 · 不扣分</el-tag>
              <el-tag v-else size="small" :type="severityTags[issue.severity]?.type || 'info'">
                {{ severityTags[issue.severity]?.label || '待分级' }}
              </el-tag>
              <el-tag v-if="issue.needsConfirmation" size="small" type="info">待作者确认</el-tag>
              <span>{{ issue.source === 'rule' ? '规则检测' : 'AI 评审' }} · 置信度 {{ Math.round(issue.confidence * 100) }}%</span>
            </div>
            <p>{{ issue.explanation }}</p>
            <div v-for="(evidence, index) in issue.evidence" :key="index" class="issue-evidence">
              <span>第 {{ evidence.episodeNo }} 集 · 第 {{ evidence.paragraphId?.match(/-p(\d+)$/)?.[1] || '—' }} 段</span>
              <el-tag v-if="report.resolvedEvidence?.some((r) => r.issueId === issue.id && r.paragraphId === evidence.paragraphId)" type="success" size="small">此处已处理</el-tag>
              <blockquote>{{ evidence.quote }}</blockquote>
              <el-button text size="small" :disabled="running" @click="action('locate', evidence)">定位原文</el-button>
              <el-button
                size="small"
                :disabled="running || disabled || issue.advisory || report.ignoredIssues?.includes(issue.id)"
                @click="action('optimize', { ...issue, relatedEvidence: report.result.issues.find((i) => i.id === issue.id)?.evidence || issue.evidence, evidence: [evidence] })">
                {{ qualityActionKind(issue) === 'delete-preview' ? '处理重复' : '优化此处' }}
              </el-button>
            </div>
            <div class="issue-suggestion">
              <b>优化建议</b>
              <p>{{ issue.suggestion }}</p>
            </div>
            <p v-if="report.ignoredIssues?.includes(issue.id)" class="quality-note">此问题已忽略，不参与一键优化；点击“恢复问题”后可继续处理。</p>
            <p v-else-if="issue.advisory" class="quality-note">此项仅供创作时参考，不参与评分，也不自动改写正文。</p>
            <p v-else-if="issue.evidence.length" class="quality-note">
              {{ qualityActionKind(issue) === 'delete-preview' ? '选择需要移除的一处查看删除预览；也可以保留原文并改写。' : '选择上方一处原文生成修改候选，确认应用后会返回此报告。' }}
            </p>
          </article>
        </template>
      </template>
    </div>
  </el-drawer>
  <QualityOptimizer ref="optimizer" :save="save" @applied="optimizationApplied" />
</template>

<style scoped>
.quality-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
.quality-controls .model-selector {
  flex: 1;
}
.quality-note {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.9;
  margin: 15px 0;
}
.quality-scoring {
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 9px;
  line-height: 1.8;
  font-size: 14px;
}
.quality-scoring summary {
  color: var(--purple);
  cursor: pointer;
}
.quality-scoring p {
  margin-top: 10px;
}
.quality-progress {
  margin: 18px 0;
  font-size: 14px;
}
.history-row {
  display: flex;
  gap: 15px;
  align-items: center;
  margin: 24px 0;
  font-size: 14px;
}
.history-row .el-select {
  flex: 1;
}
.quality-score {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 30px;
  margin-top: 20px;
}
.quality-score strong {
  display: block;
  color: var(--el-color-primary);
  font-size: 48px;
  margin: 12px 0;
}
.quality-score strong small {
  font-size: 16px;
  margin-left: 10px;
}
.quality-score p,
.quality-score span {
  font-size: 14px;
  line-height: 1.8;
}
.dimension-list {
  display: grid;
  gap: 10px;
}
.dimension-list > div {
  display: flex;
  justify-content: space-between;
}
.dimension-list small {
  color: var(--el-text-color-secondary);
  margin-left: 6px;
}
.issue-heading {
  margin: 26px 0 16px;
  flex-wrap: wrap;
  gap: 12px;
}
.issue-heading .el-select {
  width: 160px;
}
.quality-issue {
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px;
  margin: 14px 0;
}
.issue-title {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.issue-title h4 {
  font-size: 16px;
}
.issue-title > span,
.quality-issue p,
.issue-evidence {
  font-size: 14px;
  line-height: 1.8;
}
.quality-issue > p {
  margin: 12px 0;
}
.issue-evidence {
  padding: 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  margin-top: 8px;
}
.issue-evidence blockquote {
  margin: 6px 0;
  white-space: pre-wrap;
}
.issue-suggestion {
  margin: 15px 0;
  font-size: 14px;
}
@media (max-width: 650px) {
  .quality-controls {
    flex-wrap: wrap;
  }
  .quality-score {
    grid-template-columns: 1fr;
  }
}
</style>
