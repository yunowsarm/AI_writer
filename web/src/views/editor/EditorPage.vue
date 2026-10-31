<script setup>
/** 完整编辑工作台：分集、富文本、元信息、版本、导出与先审后公开。 */
import { ref, onMounted, onBeforeUnmount, computed, nextTick, watch } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router'
import { useEditor, EditorContent } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { useAuth } from '../../stores/auth'
import { api, downloadScript } from '../../api/client'
import { useDocument } from './useDocument'
import { standardize, findQuoteRange, planParagraphDeletion } from './document'
import { genres, dateLabel, statusLabel, defaultParams } from '../../shared/format'
import { reportError, success, askText, confirmAction } from '../../shared/feedback'
import AiAssist from './AiAssist.vue'
import QualityPanel from './QualityPanel.vue'
import { locateQuotedText } from '../../shared/evidenceAnchor'
import EmptyState from '../../components/EmptyState.vue'
import EditorToolbar from './EditorToolbar.vue'
import VersionDiff from './VersionDiff.vue'
import { ChangeTracking } from './changeTracking'
import QualityDeleteDialog from './QualityDeleteDialog.vue'
import { qualityActionKind } from '../../../../shared/qualityResolution.js'
import { centerSelection } from './scrollSelection'
import AddEpisodeDialog from './AddEpisodeDialog.vue'
import { scriptTagOptions } from '../../shared/scriptTags'
const addEpisodeDialog = ref(null),
  removingEpisode = ref(null)
const tagOptions = computed(() => [...new Set([...(metadata.value?.tags || []), ...scriptTagOptions])])
const deleteCandidate = ref(null),
  deleting = ref(false)
const route = useRoute(),
  router = useRouter(),
  auth = useAuth(),
  script = ref(null),
  error = ref(''),
  busy = ref(false),
  versions = ref([]),
  versionsOpen = ref(false),
  previewVersion = ref(null),
  metadataOpen = ref(false),
  metadata = ref(null),
  assist = ref(null),
  assistBusy = ref(false),
  qualityBusy = ref(false),
  qualityPanel = ref(null)
const aiBusy = computed(() => assistBusy.value)
const editing = ref(false),
  editorUiVersion = ref(0)
const editor = useEditor({
  extensions: [StarterKit.configure({ link: { openOnClick: false } }), ChangeTracking],
  content: '<p></p>',
  editable: false,
  onSelectionUpdate: () => editorUiVersion.value++,
  onTransaction: () => editorUiVersion.value++,
  onUpdate: () => documentState.changed()
})
const documentState = useDocument(editor),
  { episode, dirty, saving, saveError } = documentState
const words = computed(() => editor.value?.getText().replace(/\s/g, '').length || 0)

/**
 * 读取当前剧本详情，有分集时载入首集正文，并更新加载和错误状态。
 */
async function load() {
  busy.value = true
  try {
    script.value = await api('/scripts/' + route.params.id)
    documentState.loadEpisode(script.value.episodes.find((e) => e.id === Number(route.query.episode)) || script.value.episodes[0] || null)
    error.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

/**
 * 委托自动保存模块提交正文，保留调用方指定的版本原因。
 */
async function save(reason = '手动保存') {
  await documentState.save(reason)
}

/**
 * 质量报告定位前保存当前正文并核对快照，防止旧报告指向已变化的内容。
 * 定位使用富文本段落的真实文档位置，跨集时先载入目标分集。
 */
async function locateQuality({ value, snapshot }) {
  await save()
  const latest = await api('/scripts/' + script.value.id)
  const expected = snapshot.episodes.find((e) => e.id === value.episodeId)
  const current = latest.episodes.find((e) => e.id === value.episodeId)
  if (!expected || !current) throw new Error('该分集不存在，请重新评估')
  const anchor = locateQuotedText(current.content_text, value.quote, { snapshotText: expected.content_text, paragraphId: value.paragraphId })
  if (anchor.status !== 'available') throw new Error('这处原文已改动或不唯一，请手动选择需调整的文字；其他未改动建议仍可继续处理')
  script.value = latest
  documentState.loadEpisode(current)
  await nextTick()
  const range = findQuoteRange(editor.value.state.doc, value.quote, anchor)
  if (!range) throw new Error('未能在编辑器中定位该引用，请参考报告原文手动选择')
  editor.value.commands.setTextSelection(range)
  await nextTick()
  centerSelection(editor.value, range)
  return { range, expected, current }
}

/** 证据定位只改变选区；定向优化复用 AI 助手的候选与版本保护。 */
async function qualityAction(payload, optimize = false) {
  try {
    const issue = payload.value
    const located = await locateQuality({ ...payload, value: optimize ? issue.evidence[0] : issue })
    if (optimize && !payload.forceRewrite && qualityActionKind(issue) === 'delete-preview') {
      prepareQualityDeletion(payload, located)
      return
    }
    if (optimize)
      await assist.value.optimize(
        (payload.forceRewrite
          ? '作者选择保留该段并改写，暂不执行删除建议。避免与对照引用逐字重复，不引入新的事实。\n对照引用：' +
            (issue.relatedEvidence || [])
              .filter((e) => e.paragraphId !== issue.evidence[0].paragraphId)
              .map((e) => e.quote)
              .join('\n')
          : '质量评估建议：' + issue.suggestion) +
          '\n问题依据：' +
          issue.explanation +
          '\n只修改选中内容，保持角色、事实与前后文一致。',
        {
          reportId: payload.reportId,
          issueId: issue.id,
          paragraphId: issue.evidence[0].paragraphId
        }
      )
  } catch (e) {
    reportError(e)
    await qualityPanel.value.show(payload.reportId)
  }
}

/** 引用仅作定位线索，删除预览展示整个段落，防止截断引用留下残句。 */
function prepareQualityDeletion(payload, { range, expected, current }) {
  const issue = payload.value,
    evidence = issue.evidence[0]
  const plan = planParagraphDeletion(editor.value.state.doc, range, evidence.quote)
  const references = (issue.relatedEvidence || issue.evidence).filter((e) => e.paragraphId !== evidence.paragraphId)
  for (const reference of references.filter((e) => e.episodeId === current.id)) {
    const anchor = locateQuotedText(current.content_text, reference.quote, { snapshotText: expected.content_text, paragraphId: reference.paragraphId })
    if (anchor.status !== 'available') continue
    const otherRange = findQuoteRange(editor.value.state.doc, reference.quote, anchor)
    if (otherRange && planParagraphDeletion(editor.value.state.doc, otherRange, reference.quote).from === plan.from)
      throw new Error('两处引用属于同一个长段落，请手动选中重复片段删除，或使用改写，避免整段误删')
  }
  const after = editor.value.state.tr.deleteRange(plan.from, plan.to).doc
  const near = Math.min(plan.from, after.content.size)
  deleteCandidate.value = {
    ...plan,
    payload,
    episodeId: episode.value.id,
    episodeNo: episode.value.episode_no,
    revision: episode.value.revision,
    document: JSON.stringify(editor.value.getJSON()),
    references,
    preview: after.textBetween(Math.max(0, near - 180), Math.min(after.content.size, near + 320), '\n')
  }
}

/** 放弃删除回到原报告；不会修改正文或建议状态。 */
async function cancelQualityDeletion() {
  if (deleting.value) return
  const candidate = deleteCandidate.value
  deleteCandidate.value = null
  if (candidate) await qualityPanel.value.show(candidate.payload.reportId)
}

/** 删除前重新核对版本与文档，保存成功后再标记该重复问题，支持撤销和版本恢复。 */
async function applyQualityDeletion() {
  const candidate = deleteCandidate.value
  if (!candidate || deleting.value) return
  deleting.value = true
  try {
    if (episode.value.id !== candidate.episodeId || episode.value.revision !== candidate.revision || JSON.stringify(editor.value.getJSON()) !== candidate.document)
      throw new Error('正文已更新，请关闭预览并重新定位要删除的段落')
    editor.value.chain().focus().deleteRange({ from: candidate.from, to: candidate.to }).run()
    await save('删除重复段落')
    deleteCandidate.value = null
    success('重复段落已删除并保存，可通过撤销或版本记录恢复')
    const issue = candidate.payload.value
    // 两处对照只需删掉其中一处；三处以上仍须保留其他待处理位置。
    await qualityPanel.value.markApplied(candidate.payload.reportId, issue.id, (issue.relatedEvidence || issue.evidence).length > 2 ? issue.evidence[0].paragraphId : undefined)
  } catch (e) {
    reportError(e)
  } finally {
    deleting.value = false
  }
}

/** 作者选择保留该段时才调用 AI，并继续沿用原报告的逐处处理上下文。 */
async function rewriteQualityDeletion() {
  const candidate = deleteCandidate.value
  if (!candidate || deleting.value) return
  deleteCandidate.value = null
  await qualityAction({ ...candidate.payload, forceRewrite: true }, true)
}

/** 开关自由编辑；退出前保存，保存失败时留在编辑模式。 */
async function toggleEditing() {
  try {
    const readingPosition = { top: window.scrollY, left: window.scrollX, behavior: 'instant' }
    if (editing.value) {
      await save('退出编辑模式')
      editor.value.commands.confirmReviewChanges()
    }
    editing.value = !editing.value
    editor.value.setEditable(editing.value, false)
    await nextTick()
    // contenteditable 切换后浏览器可能自动滚动旧选区；布局提交后恢复原阅读位置。
    requestAnimationFrame(() => window.scrollTo(readingPosition))
  } catch (e) {
    reportError(e)
  }
}

/** 应用建议后回到原报告并标记单项完成，支持继续处理下一条。 */
async function assistApplied(context) {
  success('AI 修改已应用并保存')
  if (context?.reportId) await qualityPanel.value.markApplied(context.reportId, context.issueId, context.paragraphId)
}

/** 放弃候选也能回到原报告，不标记完成。 */
function assistDismissed(context) {
  if (context?.reportId) qualityPanel.value.show(context.reportId)
}

/** 整批优化已在服务端统一保存，重载当前集，历史版本仍可恢复。 */
async function optimizationApplied() {
  try {
    const currentId = episode.value?.id
    script.value = await api('/scripts/' + script.value.id)
    const latest = script.value.episodes.find((e) => e.id === currentId) || script.value.episodes[0]
    if (latest) documentState.loadEpisode(latest)
  } catch (e) {
    reportError(e)
  }
}

/**
 * 手动保存分集并提示结果，错误统一交给反馈工具。
 */
async function manualSave() {
  try {
    await save()
    editor.value.commands.confirmReviewChanges()
    success('剧本已保存到 MySQL')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 切集前先保存当前正文，再读取最新剧本和目标分集，避免载入过期 revision。
 */
async function selectEpisode(e) {
  try {
    await save()
    const latest = await api('/scripts/' + script.value.id)
    script.value = latest
    documentState.loadEpisode(latest.episodes.find((x) => x.id === e.id))
  } catch (err) {
    reportError(err)
  }
}

/**
 * 收集分集名、保存当前内容，再创建新集并载入后端返回的最新记录。
 */
function newEpisode() {
  addEpisodeDialog.value.show()
}

/** 新分集创建完成后先保存当前稿，再读取新集，后台任务完成不覆盖未保存的编辑。 */
async function episodeAdded({ scriptId, episodeId }) {
  if (scriptId !== script.value?.id) return
  try {
    await save()
    script.value = await api('/scripts/' + script.value.id)
    documentState.loadEpisode(script.value.episodes.find((e) => e.id === episodeId) || script.value.episodes[0] || null)
  } catch (e) {
    reportError(e)
  }
}

/** 删除前确认正文和版本记录会被移除；当前集删除后切换相邻集，允许删至空剧本。 */
async function removeEpisode(target) {
  if (!(await confirmAction('删除《' + target.title + '》及其历史版本？后续集号会自动前移，此操作无法撤销。'))) return
  removingEpisode.value = target.id
  try {
    await save('删除分集前保存')
    const revision = episode.value?.id === target.id ? episode.value.revision : target.revision
    const index = script.value.episodes.findIndex((e) => e.id === target.id)
    const selectedId = episode.value?.id
    await api('/episodes/' + target.id, { method: 'DELETE', body: { revision } })
    script.value = await api('/scripts/' + script.value.id)
    documentState.loadEpisode(script.value.episodes.find((e) => e.id === selectedId) || script.value.episodes[Math.min(index, script.value.episodes.length - 1)] || null)
    success('分集已删除')
  } catch (e) {
    reportError(e)
  } finally {
    removingEpisode.value = null
  }
}

/**
 * 格式化前先保存当前修改，再规范脚本标记并保存格式化后的版本，方便回退。
 */
async function format() {
  try {
    await save('格式标准化前')
    editor.value.commands.setContent(standardize(editor.value.getText()))
    await save('格式标准化')
    success('格式已统一，可在版本记录中回退')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 保存当前内容后读取版本摘要，打开历史版本面板。
 */
async function showVersions() {
  try {
    await save()
    versions.value = await api('/episodes/' + episode.value.id + '/versions')
    versionsOpen.value = true
  } catch (e) {
    reportError(e)
  }
}

/**
 * 读取所选历史版本用于只读预览，不修改当前编辑器内容。
 */
async function viewVersion(v) {
  try {
    previewVersion.value = await api(`/episodes/${episode.value.id}/versions/${v.id}`)
  } catch (e) {
    reportError(e)
  }
}

/**
 * 确认后先保存当前修改，再携带最新 revision 请求恢复历史内容。
 * 使用后端返回的恢复结果重新加载编辑器，清理历史预览与面板状态。
 */
async function restore(v) {
  if (!(await confirmAction('恢复此版本？当前内容会先保留为回退前备份。'))) return
  try {
    await save()
    const result = await api('/episodes/' + episode.value.id + '/restore', {
      method: 'POST',
      body: { versionId: v.id, revision: episode.value.revision }
    })
    documentState.loadEpisode(result)
    versionsOpen.value = false
    previewVersion.value = null
    success('已恢复版本并保存')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 从剧本复制标题、题材、标签和大纲等字段，打开资料编辑表单。
 */
function editMetadata() {
  metadata.value = {
    title: script.value.title,
    genre: script.value.genre,
    synopsis: script.value.synopsis,
    tags: [...script.value.tags],
    outline: script.value.outline,
    config: script.value.config
  }
  metadataOpen.value = true
}

/**
 * 提交剧本资料并同步本地展示；公开快照仍需重新审核。
 */
async function saveMetadata() {
  try {
    await api('/scripts/' + script.value.id, { method: 'PATCH', body: metadata.value })
    Object.assign(script.value, metadata.value)
    metadataOpen.value = false
    success('剧本资料已更新，公开版本需重新审核')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 确认后先保存正文，再提交整部剧本审核，将本地审核状态更新为 pending。
 */
async function publish() {
  if (script.value.visibility === 'public') return reportError(new Error('该剧本已公开；请先设为私有，再提交修改后的版本'))
  if (!(await confirmAction('提交当前整部剧本进行公开审核？通过后才会出现在广场。'))) return
  try {
    await save()
    await api('/scripts/' + script.value.id + '/publish', { method: 'POST' })
    script.value.review_status = 'pending'
    success('已提交审核')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 确认后撤回公开内容与待审申请，同步页面可见性及审核状态。
 */
async function makePrivate() {
  if (!(await confirmAction('设为私有会立即撤回公开链接和待审核申请，确认继续？'))) return
  try {
    await api('/scripts/' + script.value.id + '/unpublish', { method: 'POST' })
    script.value.visibility = 'private'
    script.value.review_status = 'none'
    success('已撤回并设为私有')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 导出前先保存正文；复制模式重新读取整部最新正文，文件模式交给下载工具。
 */
async function exportFile(type) {
  try {
    await save()
    if (type === 'copy') {
      const latest = await api('/scripts/' + script.value.id)
      await navigator.clipboard.writeText(latest.title + '\n\n' + latest.episodes.map((e) => e.title + '\n' + e.content_text).join('\n\n'))
      success('全文已复制')
    } else await downloadScript(script.value.id, type, script.value.title)
  } catch (e) {
    reportError(e)
  }
}

/**
 * 复制本站公开阅读链接，实际内容是否可访问由公开接口重新校验。
 */
async function share() {
  try {
    await navigator.clipboard.writeText(location.origin + '/s/' + script.value.id)
    success('公开分享链接已复制')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 先保存正文，再将剧本资料、大纲及合并后的生成参数保存为个人模板。
 */
async function saveTemplate() {
  try {
    await save()
    await api('/templates', {
      method: 'POST',
      body: {
        title: script.value.title,
        genre: script.value.genre,
        description: script.value.synopsis,
        outline: script.value.outline || editor.value.getText(),
        params: {
          ...defaultParams(),
          ...script.value.config,
          theme: script.value.synopsis || script.value.title,
          style: script.value.genre
        }
      }
    })
    success('已保存到个人模板库')
  } catch (e) {
    reportError(e)
  }
}

/** 统一分发悬浮菜单操作，快捷按钮和更多菜单共用同一套保存与权限逻辑。 */
function toolbarAction(key) {
  const actions = {
    editing: toggleEditing,
    quality: () => qualityPanel.value.show(),
    metadata: editMetadata,
    versions: showVersions,
    save: manualSave,
    publish,
    format,
    scene: () => editor.value.chain().focus().insertContent('<h2>【场景】新场景 · 日 · 内</h2><p></p>').run(),
    character: () => editor.value.chain().focus().insertContent('<p><strong>【人物】角色姓名</strong></p>').run()
  }
  if (key.startsWith('export-')) return exportFile(key.slice(7))
  return actions[key]?.()
}

/**
 * 存在未保存修改、保存请求或 AI 任务时，触发浏览器原生离开提醒。
 */
function beforeUnload(e) {
  if (dirty.value || saving.value || aiBusy.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// 路由离开前阻止进行中的 AI 任务，并尝试保存正文；失败时由用户确认是否放弃修改。
onBeforeRouteLeave(async () => {
  if (aiBusy.value) {
    reportError(new Error('请先结束 AI 生成'))
    return false
  }
  try {
    await save()
    return true
  } catch (e) {
    reportError(e)
    return await confirmAction('保存失败，离开将丢失当前未保存的修改。仍要离开？')
  }
})

/** 任务中心可能从另一部剧本跳回结果；复用编辑页前先保存旧稿，避免串集。 */
onBeforeRouteUpdate(async (to, from) => {
  if (to.params.id === from.params.id) return true
  if (aiBusy.value) {
    reportError(new Error('请先结束当前 AI 改写'))
    return false
  }
  try {
    await save()
    return true
  } catch (e) {
    reportError(e)
    return false
  }
})

watch(
  () => route.params.id,
  async (id, old) => {
    if (!id || id === old) return
    editing.value = false
    editor.value?.setEditable(false, false)
    await load()
    await nextTick()
    if (route.query.optimization) qualityPanel.value?.showOptimization(route.query.optimization)
    else if (route.query.report || route.query.job) qualityPanel.value?.show(route.query.report || undefined)
  }
)

// 加载剧本并注册浏览器关闭提醒。
onMounted(async () => {
  await load()
  await nextTick()
  if (route.query.report || route.query.job) qualityPanel.value?.show(route.query.report || undefined)
  if (route.query.optimization) qualityPanel.value?.showOptimization(route.query.optimization)
  window.addEventListener('beforeunload', beforeUnload)
})
watch(
  () => route.query.report,
  async (id) => {
    if (id && script.value?.id === Number(route.params.id)) {
      await nextTick()
      qualityPanel.value?.show(id)
    }
  }
)
watch(
  () => route.query.episode,
  async (id) => {
    if (id && script.value?.id === Number(route.params.id)) await episodeAdded({ scriptId: script.value.id, episodeId: Number(id) })
  }
)

watch(
  () => [route.query.optimization, route.query.opened],
  async ([id]) => {
    if (id && script.value?.id === Number(route.params.id)) {
      await nextTick()
      qualityPanel.value?.showOptimization(id)
    }
  }
)

// 卸载时清理自动保存定时器与浏览器事件监听。
onBeforeUnmount(() => {
  documentState.dispose()
  window.removeEventListener('beforeunload', beforeUnload)
})
</script>
<template>
  <div v-loading="busy">
    <EmptyState v-if="error" title="无法打开剧本" :description="error"><el-button @click="load">重试</el-button></EmptyState>
    <template v-else-if="script">
      <div class="editor-header">
        <div>
          <button class="text-button" @click="router.push('/scripts')">
            <el-icon class="leading-icon" aria-hidden="true"><Back /></el-icon>
            我的剧本
          </button>
          <h1 class="editor-title" @click="editMetadata">
            {{ script.title }}
            <button title="编辑剧本资料">
              <el-icon><EditPen /></el-icon>
            </button>
          </h1>
          <p>
            <span class="save-dot" :class="{ dirty }"></span>
            {{ saveError || (saving ? '正在保存…' : dirty ? '有未保存修改' : '已保存到 MySQL') }}
            <span>· {{ words }} 字 · {{ statusLabel(script) }}</span>
          </p>
        </div>
      </div>
      <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" description="未保存内容仍在编辑器中。可先复制备份，再重新打开剧本合并修改。" />
      <el-alert v-if="script.reviews[0]?.status === 'rejected'" :title="'审核意见：' + script.reviews[0].reason" type="warning" :closable="false" />
      <EditorToolbar
        :editor="editor"
        :revision="editorUiVersion"
        :editing="editing"
        :disabled="aiBusy"
        :saving="saving"
        :has-episode="!!episode"
        :review-status="script.review_status"
        :visibility="script.visibility"
        @action="toolbarAction" />
      <div class="editor-layout">
        <aside class="outline panel">
          <h3>剧本分集</h3>
          <p class="muted">{{ script.episodes.length }} 集 · {{ script.genre }}</p>
          <div v-for="e in script.episodes" :key="e.id" class="episode-nav-row" :class="{ selected: episode?.id === e.id }">
            <button :disabled="aiBusy || !!removingEpisode" @click="selectEpisode(e)">
              <span>{{ String(e.episode_no).padStart(2, '0') }}</span>
              {{ e.id === episode?.id ? episode.title : e.title }}
            </button>
            <el-button
              text
              type="danger"
              class="delete-episode"
              :aria-label="'删除分集：' + e.title"
              :title="'删除分集：' + e.title"
              :loading="removingEpisode === e.id"
              :disabled="aiBusy || !!removingEpisode"
              @click="removeEpisode(e)">
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
          <el-button @click="newEpisode" :disabled="aiBusy">
            <el-icon class="leading-icon" aria-hidden="true"><Plus /></el-icon>
            添加分集
          </el-button>
          <div class="outline-note">
            <el-icon class="leading-icon" aria-hidden="true"><Opportunity /></el-icon>
            创作提示
            <p>
              让每场戏都有目标，
              <br />
              让每个角色都有选择。
            </p>
          </div>
          <el-button v-if="auth.capabilities.aiConfigured && script.config?.theme" @click="router.push('/create?resume=' + script.id)">继续 AI 分集生成</el-button>
          <el-button v-if="script.visibility === 'public'" @click="share">复制公开分享链接</el-button>
          <el-button v-if="script.visibility === 'public' || script.review_status === 'pending'" @click="makePrivate">设为私有 / 撤回</el-button>
          <el-button @click="saveTemplate">保存为个人模板</el-button>
        </aside>
        <div class="writing-panel">
          <EmptyState v-if="!episode" title="先添加第一集"><el-button @click="newEpisode">添加分集</el-button></EmptyState>
          <template v-else>
            <div class="episode-title-row">
              <el-input v-model="episode.title" :disabled="!editing" maxlength="120" @input="documentState.changed()" />
              <span>第 {{ episode.episode_no }} 集</span>
            </div>
            <p class="review-legend">
              <span class="added">绿色新增</span>
              ·
              <span class="removed">红色删除</span>
              · 手动保存或退出编辑后收起标注，历史版本可对比。
            </p>
            <div class="writing-paper">
              <div class="paper-document-meta">
                ORIGINAL SCRIPT
                <span>第 {{ episode.episode_no }} 集 / REV {{ episode.revision }}</span>
              </div>
              <EditorContent :editor="editor" />
              <p class="document-end">· 未完待续 ·</p>
            </div>
          </template>
        </div>
        <AiAssist
          v-if="episode && editor"
          ref="assist"
          :editor="editor"
          :episode="episode"
          :save="save"
          :enabled="auth.capabilities.aiConfigured"
          :disabled="false"
          @busy="(v) => (assistBusy = v)"
          @applied="assistApplied"
          @dismissed="assistDismissed" />
      </div>
    </template>
  </div>
  <QualityPanel
    v-if="script"
    ref="qualityPanel"
    :script-id="script.id"
    :save="save"
    :disabled="aiBusy"
    @busy="qualityBusy = $event"
    @optimization-applied="optimizationApplied"
    @locate="qualityAction($event)"
    @optimize="qualityAction($event, true)" />
  <QualityDeleteDialog
    :candidate="deleteCandidate"
    :busy="deleting"
    :can-rewrite="auth.capabilities.aiConfigured"
    @cancel="cancelQualityDeletion"
    @confirm="applyQualityDeletion"
    @rewrite="rewriteQualityDeletion" />
  <el-drawer v-model="versionsOpen" title="版本记录" size="420px">
    <p class="fine muted">每次保存保留不可变快照。回退会新建版本，历史仍可查看。</p>
    <el-empty v-if="!versions.length" description="开始编辑并保存后，这里会出现版本" />
    <div class="snapshot" v-for="v in versions" :key="v.id">
      <div>
        <b>{{ v.reason }}</b>
        <span>REV {{ v.revision }}</span>
      </div>
      <p>{{ dateLabel(v.created_at) }} · {{ v.words }} 字</p>
      <el-button size="small" @click="viewVersion(v)">对比当前稿</el-button>
      <el-button size="small" @click="restore(v)">恢复版本</el-button>
    </div>
  </el-drawer>
  <el-dialog :model-value="!!previewVersion" @close="previewVersion = null" title="历史版本对比" width="min(94vw, 900px)">
    <VersionDiff v-if="previewVersion" :before="previewVersion.content_text" :after="editor?.getText() || ''" />
  </el-dialog>
  <el-dialog v-model="metadataOpen" title="剧本资料与故事大纲" width="700px">
    <el-form v-if="metadata" label-position="top">
      <el-form-item label="剧本名称"><el-input v-model="metadata.title" maxlength="120" /></el-form-item>
      <el-form-item label="题材">
        <el-select v-model="metadata.genre"><el-option v-for="g in genres" :key="g" :label="g" :value="g" /></el-select>
      </el-form-item>
      <el-form-item label="标签（最多 10 个）">
        <el-select v-model="metadata.tags" multiple filterable allow-create default-first-option :multiple-limit="10" placeholder="选择推荐标签，或输入新标签后按回车">
          <el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" />
        </el-select>
      </el-form-item>
      <el-form-item label="故事简介"><el-input type="textarea" v-model="metadata.synopsis" :rows="3" maxlength="5000" /></el-form-item>
      <el-form-item label="完整大纲"><el-input type="textarea" v-model="metadata.outline" :rows="10" maxlength="100000" /></el-form-item>
      <el-button type="primary" @click="saveMetadata">保存资料</el-button>
    </el-form>
  </el-dialog>
  <AddEpisodeDialog v-if="script" ref="addEpisodeDialog" :script="script" :save="save" @added="episodeAdded" />
</template>
<style scoped>
.episode-nav-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 7px;
  margin-bottom: 6px;
}
.episode-nav-row.selected {
  background: var(--el-color-primary-light-9);
  color: var(--purple);
}
.episode-nav-row > button:first-child {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 8px;
  text-align: left;
  padding: 12px 8px;
  font-size: 15px;
  overflow-wrap: anywhere;
}
.episode-nav-row > button:first-child > span {
  color: var(--el-text-color-secondary);
}
.episode-nav-row .delete-episode {
  flex: 0 0 30px;
  padding: 6px;
  margin: 0;
}
.review-legend {
  margin: 4px 0 12px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.added {
  color: var(--review-added-ink);
}
.removed {
  color: var(--review-deleted-ink);
}
:deep(.review-insert) {
  background: var(--el-color-success-light-9);
  color: var(--review-added-ink);
  border-bottom: 2px solid var(--el-color-success);
}
:deep(.review-delete) {
  background: var(--el-color-danger-light-9);
  color: var(--review-deleted-ink);
  text-decoration: line-through;
  font-size: 0.9em;
  user-select: none;
  pointer-events: auto;
}
:deep(.persistent-selection) {
  background: var(--el-color-primary-light-7);
  box-shadow: inset 0 -1px var(--purple);
}
:deep(.tiptap) {
  line-height: 1.85;
}
:deep(.tiptap p) {
  margin: 0 0 8px;
}
:deep(.tiptap h2) {
  margin: 20px 0 12px;
}
:deep(.tiptap em) {
  font-style: italic;
  font-synthesis: style;
}
</style>
