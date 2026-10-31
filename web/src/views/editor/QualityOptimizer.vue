<script setup>
/** 一键优化工作流：计划 → 后台候选 → 差异预览 → 选择应用；关闭页面不取消任务。 */
import { ref, computed, watch } from 'vue'
import { api } from '../../api/client'
import { reportError, success } from '../../shared/feedback'
import { useTasks } from '../../stores/tasks'
import ModelSelector from '../../components/ModelSelector.vue'
import VersionDiff from './VersionDiff.vue'

const props = defineProps({ save: Function })
const emit = defineEmits(['applied'])
const tasks = useTasks()
const open = ref(false),
  stage = ref('plan'),
  plan = ref(null),
  selection = ref(),
  jobId = ref(null),
  result = ref(null)
const loading = ref(false),
  applying = ref(false),
  error = ref(''),
  phase = ref(''),
  progress = ref(0),
  chosen = ref([]),
  expanded = ref([])
const currentReviewVersion = 'paired-2.0'
const eligible = computed(
  () => result.value?.changes.filter((c) => ['completed', 'review'].includes(c.status) && (result.value.applied || result.value.reviewVersion === currentReviewVersion || c.kind === 'delete')) || []
)
const recommended = computed(() => eligible.value.filter((c) => c.status === 'completed'))
const pendingReview = computed(() => eligible.value.filter((c) => c.status === 'review'))
const allChosen = computed(() => recommended.value.length > 0 && recommended.value.every((c) => chosen.value.includes(c.id)))
const allEligibleChosen = computed(() => eligible.value.length > 0 && eligible.value.every((c) => chosen.value.includes(c.id)))
const recommendedPartial = computed(() => recommended.value.some((c) => chosen.value.includes(c.id)) && !allChosen.value)
const failed = computed(() => result.value?.changes.filter((c) => ['failed', 'pending', 'reviewing', 'rejected'].includes(c.status)) || [])
const canApply = computed(() => chosen.value.length && !result.value?.applied && !applying.value)
const statusNames = { completed: '复核通过', review: '待人工确认', reviewing: '等待复核', rejected: '已保留原稿', failed: '未完成', pending: '未生成', unchanged: '模型未作修改' }

/** 启动前先保存并读取实际计划，调用次数按合并后的段落计算。 */
async function show(reportId, model) {
  open.value = true
  stage.value = 'plan'
  loading.value = true
  error.value = ''
  plan.value = null
  result.value = null
  jobId.value = null
  selection.value = model ? { ...model } : undefined
  try {
    await props.save('一键优化前保存')
    plan.value = await api('/quality/reports/' + reportId + '/optimization-plan')
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

/** 后台生成只创建候选，模型调用使用个人供应商，正文暂不更新。 */
async function generate() {
  if (!plan.value?.total || !selection.value) return
  loading.value = true
  error.value = ''
  try {
    await props.save('一键优化前保存')
    const task = await api('/quality/reports/' + plan.value.reportId + '/optimize', { method: 'POST', body: { fingerprint: plan.value.fingerprint, selection: selection.value } })
    jobId.value = task.jobId
    stage.value = 'running'
    progress.value = 0
    phase.value = '正在准备优化候选'
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
  if (stage.value === 'running') {
    await tasks.refresh()
    await syncTask()
  }
}

/** 任务结束或从任务中心进入时获取持久化结果，候选可刷新后继续查看。 */
async function loadResult() {
  if (!jobId.value || loading.value) return
  loading.value = true
  try {
    const value = await api('/quality/optimizations/' + jobId.value)
    result.value = value.result
    if (value.status !== 'running') {
      stage.value = 'result'
      chosen.value = recommended.value.map((c) => c.id)
      expanded.value = (recommended.value.length ? recommended.value : result.value?.changes || []).slice(0, 1).map((c) => c.id)
      if (!value.result) error.value = '本次未生成候选，请返回报告重新优化'
    }
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

/** 全局任务中心负责轮询，此处只消费进度变化，切换页面也不丢失任务。 */
async function syncTask() {
  if (!jobId.value || stage.value !== 'running') return
  const task = tasks.items.find((t) => t.id === jobId.value)
  if (!task) return
  phase.value = task.progress?.message || '正在后台优化'
  progress.value = Math.min(100, Math.round(((task.progress?.completed || 0) / Math.max(1, task.progress?.total || 1)) * 100))
  if (task.status !== 'running') await loadResult()
}

/** 从任务中心直接找回候选或运行状态。 */
async function showJob(id) {
  open.value = true
  stage.value = 'running'
  jobId.value = id
  error.value = ''
  result.value = null
  await loadResult()
  await tasks.refresh()
  await syncTask()
}

/** 停止后保留此前已完成的候选，可继续预览并选择应用。 */
async function stop() {
  try {
    await api('/ai/jobs/' + jobId.value + '/cancel', { method: 'POST' })
    await tasks.refresh()
    await syncTask()
  } catch (e) {
    reportError(e)
  }
}

/** 应用前保存当前编辑器；后端会再次核对所有受影响分集，任一冲突都不覆盖。 */
async function apply() {
  if (!canApply.value) return
  applying.value = true
  error.value = ''
  try {
    await props.save('应用一键优化前保存')
    const applied = await api('/quality/optimizations/' + jobId.value + '/apply', {
      method: 'POST',
      body: { changeIds: chosen.value, acknowledgedReviewIds: pendingReview.value.filter((c) => chosen.value.includes(c.id)).map((c) => c.id) }
    })
    result.value.applied = applied
    success('已应用选中的优化，原稿已保留在版本记录中')
    emit('applied', { scriptId: result.value.scriptId, reportId: result.value.reportId, ...applied })
  } catch (e) {
    error.value = e.message
  } finally {
    applying.value = false
  }
}

function toggleAll(value) {
  chosen.value = value ? [...new Set([...chosen.value, ...recommended.value.map((c) => c.id)])] : chosen.value.filter((id) => !recommended.value.some((c) => c.id === id))
}

/** 显式全选所有可应用项，包含待确认候选；被拒绝或无修改的条目不进入选区。 */
function toggleAllEligible(value) {
  chosen.value = value ? eligible.value.map((c) => c.id) : []
}

/** 作者也可以独立调整任意可应用候选。 */
function toggleChange(id, value) {
  chosen.value = value ? [...new Set([...chosen.value, id])] : chosen.value.filter((key) => key !== id)
}

/** 应用后区分采用与未采用候选。 */
function changeLabel(change) {
  if (result.value?.applied) {
    if (result.value.applied.changeIds.includes(change.id)) return '已应用'
    if (change.status === 'rejected') return '已保留原稿'
    return change.status === 'review' ? '未应用 · 待确认' : '未应用'
  }
  if (result.value?.reviewVersion !== currentReviewVersion && change.kind !== 'delete') return '需重新生成复核'
  if (change.status === 'completed' && change.kind === 'delete') return '完全重复已核对'
  return statusNames[change.status]
}

function changeType(change) {
  if (result.value?.applied && result.value.applied.changeIds.includes(change.id)) return 'success'
  if (change.status === 'review') return 'warning'
  if (change.status === 'rejected') return 'danger'
  return change.status === 'completed' ? (change.kind === 'delete' ? 'danger' : 'success') : 'info'
}
watch(() => tasks.revision, syncTask)
defineExpose({ show, showJob })
</script>

<template>
  <el-dialog
    v-model="open"
    class="quality-optimizer-dialog"
    title="按质量评估一键优化"
    width="min(96vw, 1040px)"
    top="4vh"
    :close-on-click-modal="!applying"
    :close-on-press-escape="!applying"
    :show-close="!applying">
    <div v-loading="loading">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <template v-if="stage === 'plan' && plan">
        <p class="optimizer-intro">合并同段意见后作最小修改，再交换版本顺序复核是否改善。通过复核的候选默认勾选；结论不一致的留给你确认，发现退步则保留原稿。</p>
        <div class="optimizer-stats">
          <span>
            <b>{{ plan.total }}</b>
            处待优化
          </span>
          <span>
            <b>{{ plan.aiCalls }}</b>
            次改写
          </span>
          <span>
            <b>{{ plan.reviewCalls }}</b>
            次预计复核
          </span>
          <span>
            <b>{{ plan.deletions }}</b>
            处同集完全重复删除
          </span>
        </div>
        <label class="optimizer-label">使用你的个人 API 模型</label>
        <ModelSelector v-model="selection" :disabled="loading" />
        <p class="optimizer-note">使用个人 API，改写与复核均计入 AI 用量。先按同集分批双向比较，再检查整集衔接；长候选或响应格式重试可能增加调用。篇幅仅提示；跨集事实取舍与相似段落留给作者确认。</p>
        <el-alert v-if="!plan.total" title="没有可自动处理的位置，可重新评估或查看下面的待确认事项。" type="info" :closable="false" />
        <details v-if="plan.skipped.length" class="optimizer-skipped">
          <summary>{{ plan.skipped.length }} 项需手动确认</summary>
          <p v-for="(item, i) in plan.skipped" :key="i">{{ item.title }}：{{ item.reason }}</p>
        </details>
      </template>
      <template v-if="stage === 'running'">
        <p class="optimizer-intro">{{ phase }}</p>
        <el-progress :percentage="progress" :stroke-width="8" />
        <p class="optimizer-note">可关闭此窗口继续创作，任务在后台运行。完成后从右上角任务中心查看候选。生成期间编辑了正文，应用时会提示重新优化。</p>
      </template>
      <template v-if="stage === 'result' && result">
        <el-alert v-if="result.applied" title="选中的优化已应用，未选中的内容保持原样。可从版本记录对比或恢复原稿。" type="success" :closable="false" show-icon />
        <el-alert
          v-if="result.reviewVersion !== currentReviewVersion && !result.applied"
          title="这是旧版生成的候选，未通过新版逐项问题验收。请从质量报告重新生成优化候选。"
          type="warning"
          :closable="false" />
        <el-alert
          v-if="!result.applied"
          :title="
            result.status === 'completed'
              ? '优化及复核已完成，请查看差异后应用。当前正文尚未改变。'
              : '部分候选未获一致认可或未完成复核。推荐候选已勾选；可逐项选择，或全选可应用候选（含待确认项）。退步候选仍保留原稿。'
          "
          type="info"
          :closable="false" />
        <div class="optimizer-stats">
          <span>
            <b>{{ result.applied ? result.applied.changeIds.length : recommended.length }}</b>
            {{ result.applied ? '处已应用' : '处推荐' }}
          </span>
          <span v-if="!result.applied">
            <b>{{ pendingReview.length }}</b>
            处待确认
          </span>
          <span>
            <b>{{ result.applied ? eligible.length - result.applied.changeIds.length : failed.length }}</b>
            {{ result.applied ? '处未应用' : '处保留原稿' }}
          </span>
          <span v-if="result.applied && failed.length">
            <b>{{ failed.length }}</b>
            处保留原稿
          </span>
          <span>
            <b>{{ result.skipped.length }}</b>
            项待确认
          </span>
        </div>
        <div class="optimizer-selection">
          <el-checkbox
            :model-value="allEligibleChosen"
            :indeterminate="chosen.length > 0 && !allEligibleChosen"
            :disabled="!!result.applied || applying || !eligible.length"
            @change="toggleAllEligible">
            选择全部可应用候选（含待确认项）
          </el-checkbox>
          <el-checkbox :model-value="allChosen" :indeterminate="recommendedPartial" :disabled="!!result.applied || applying || !recommended.length" @change="toggleAll">选择全部推荐候选</el-checkbox>
        </div>
        <p v-if="chosen.some((id) => pendingReview.some((c) => c.id === id))" class="optimizer-note">已选择待确认候选，确认应用表示你接受这些候选；它们不会自动标记为问题已解决。</p>
        <el-collapse v-model="expanded" class="optimizer-changes">
          <el-collapse-item v-for="change in result.changes" :key="change.id" :name="change.id">
            <template #title>
              <div class="optimizer-change-title">
                <el-checkbox
                  :model-value="chosen.includes(change.id)"
                  :aria-label="'选择第 ' + change.episodeNo + ' 集第 ' + (change.blockIndex + 1) + ' 段候选'"
                  :disabled="!eligible.some((c) => c.id === change.id) || !!result.applied || applying"
                  @change="(value) => toggleChange(change.id, value)"
                  @click.stop />
                <span class="optimizer-change-copy">第 {{ change.episodeNo }} 集 · {{ change.kind === 'delete' ? '删除重复段落' : change.issues.map((i) => i.title).join('、') }}</span>
                <el-tag size="small" :type="changeType(change)">{{ changeLabel(change) }}</el-tag>
              </div>
            </template>
            <p v-if="change.review" class="optimizer-note">
              <b>复核结论：</b>
              {{ change.review.reason }}
            </p>
            <p v-if="change.review?.summary" class="optimizer-note">
              本段目标验收：{{ change.review.summary.checked }} 项 · 已解决 {{ change.review.summary.resolved }} · 仍存在 {{ change.review.summary.remaining }} · 不确定
              {{ change.review.summary.uncertain }} · 新增 {{ change.review.summary.added }}
            </p>
            <p v-for="(finding, i) in change.review?.summary?.newIssues || []" :key="i" class="optimizer-note">新增问题：{{ finding.reason }}（原文：{{ finding.quote }}）</p>
            <p v-for="warning in change.warnings || []" :key="warning" class="optimizer-note">{{ warning }}</p>
            <VersionDiff v-if="expanded.includes(change.id) && (change.after || change.kind === 'delete')" :before="change.before" :after="change.after" caption="优化前 → 候选" />
            <p v-if="change.error || ['pending', 'unchanged'].includes(change.status)" class="optimizer-note">{{ change.error || '本段没有可应用的新内容' }}</p>
          </el-collapse-item>
        </el-collapse>
        <details v-if="result.episodeReviews?.length" class="optimizer-skipped">
          <summary>查看分集问题验收</summary>
          <div v-for="review in result.episodeReviews" :key="review.episodeId">
            <p>第 {{ result.episodes.find((e) => e.id === review.episodeId)?.episodeNo || result.changes.find((c) => c.episodeId === review.episodeId)?.episodeNo }} 集：{{ review.reason }}</p>
            <p v-if="review.summary">
              本次目标 {{ review.summary.checked }} 项 · 已解决 {{ review.summary.resolved }} · 仍存在 {{ review.summary.remaining }} · 不确定 {{ review.summary.uncertain }} · 新增
              {{ review.summary.added }}
            </p>
            <p v-for="(finding, i) in review.summary?.newIssues || []" :key="i">新增问题：{{ finding.reason }}（原文：{{ finding.quote }}）</p>
          </div>
        </details>
        <details v-if="result.skipped.length" class="optimizer-skipped">
          <summary>查看 {{ result.skipped.length }} 项待确认事项</summary>
          <p v-for="(item, i) in result.skipped" :key="i">{{ item.title }}：{{ item.reason }}</p>
        </details>
        <p class="optimizer-note">应用会一次提交选中的修改，保留优化前与优化后版本。未选中的候选不会改动正文，仍可在原报告中继续处理；分数需要重新评估后才会更新。</p>
      </template>
    </div>
    <template #footer>
      <div class="optimizer-actions">
        <el-button :disabled="applying" @click="open = false">{{ stage === 'running' ? '后台运行' : '关闭' }}</el-button>
        <el-button v-if="stage === 'plan'" type="primary" :loading="loading" :disabled="!plan?.total || !selection" @click="generate">开始一键优化</el-button>
        <el-button v-if="stage === 'running'" @click="stop">停止优化</el-button>
        <el-button v-if="stage === 'result' && !result?.applied" type="primary" :loading="applying" :disabled="!canApply" @click="apply">确认应用 {{ chosen.length }} 处修改</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
:global(.quality-optimizer-dialog.el-dialog) {
  display: flex;
  flex-direction: column;
  max-height: 92dvh;
}
:global(.quality-optimizer-dialog .el-dialog__body) {
  min-height: 0;
  flex: 1;
  overflow: auto;
  scrollbar-width: none;
}
:global(.quality-optimizer-dialog .el-dialog__footer),
:global(.quality-optimizer-dialog .el-dialog__header) {
  flex-shrink: 0;
}
.optimizer-intro {
  margin: 12px 0 20px;
  font-size: 15px;
  line-height: 1.8;
}
.optimizer-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 28px;
  padding: 18px;
  margin: 16px 0;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--el-fill-color-light);
  font-size: 14px;
}
.optimizer-stats b {
  color: var(--purple);
  font-size: 22px;
  margin-right: 5px;
}
.optimizer-label {
  display: block;
  margin: 20px 0 10px;
  font-size: 14px;
}
.optimizer-note {
  font-size: 13px;
  line-height: 1.8;
  margin: 14px 0;
  color: var(--el-text-color-secondary);
}
.optimizer-skipped {
  margin-top: 18px;
  font-size: 14px;
}
.optimizer-skipped summary {
  cursor: pointer;
  color: var(--purple);
}
.optimizer-skipped p {
  margin-top: 10px;
  line-height: 1.8;
}
.optimizer-changes {
  margin-top: 14px;
}
.optimizer-change-title {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  min-width: 0;
  padding-block: 10px;
}
.optimizer-change-copy {
  flex: 1;
  line-height: 1.6;
  overflow-wrap: anywhere;
  font-size: 15px;
}
.optimizer-change-title .el-tag {
  flex-shrink: 0;
}
:deep(.el-collapse-item__header) {
  height: auto;
}
:deep(.version-diff) {
  max-height: 34vh;
}
.optimizer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  flex-wrap: wrap;
}
.optimizer-selection {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 24px;
}
.optimizer-selection .el-checkbox {
  margin-right: 0;
}
.optimizer-actions .el-button {
  margin: 0;
}
</style>
