<script setup>
/** AI 创作页：复用参数、逐集流式生成、主动停止以及失败后续生成。 */
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuth } from '../../stores/auth'
import { api, streamApi } from '../../api/client'
import { genres, defaultParams, dateLabel } from '../../shared/format'
import { reportError, success, askText, confirmAction } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import ModelSelector from '../../components/ModelSelector.vue'
import { useTasks } from '../../stores/tasks'
import { savedGenerationProgress } from '../../shared/generationRecovery'
const tasks = useTasks()
let pageActive = true
const randomizing = ref(false),
  deleting = ref(null)
let randomController
onBeforeUnmount(() => {
  pageActive = false
  liveStream?.controller.abort()
  randomController?.abort()
})
const selection = ref(),
  activeModel = ref(''),
  recoverables = ref([]),
  recovering = ref(false)
const route = useRoute(),
  router = useRouter(),
  auth = useAuth(),
  params = ref(defaultParams()),
  customStyleMode = ref(false),
  title = ref(''),
  saved = ref([]),
  configOpen = ref(false),
  output = ref(''),
  followOutput = ref(true),
  generatedText = ref(null),
  phase = ref('等待你的灵感'),
  running = ref(false),
  scriptId = ref(null),
  jobId = ref(null),
  completed = ref(0),
  error = ref(''),
  done = ref(false),
  resumeId = ref(null)

/**
 * 仅在用户仍跟随最新内容时滚动；渲染等待期间若用户上翻，同样保留其阅读位置。
 * 只调整初稿内容区，不移动整页，不自动抢回已暂停的跟随状态。
 */
watch(output, async () => {
  if (!running.value || !followOutput.value) return
  await nextTick()
  if (!followOutput.value) return
  const container = generatedText.value
  if (container) container.scrollTop = container.scrollHeight
})

/** 手动滚离底部暂停跟随；向下滚回底部后恢复，容忍亚像素与少量排版误差。 */
function outputScrolled() {
  const container = generatedText.value
  if (container) followOutput.value = container.scrollHeight - container.clientHeight - container.scrollTop <= 24
}

/** 向上滚轮先暂停，避免同一帧新文本抢在滚动事件之前将阅读位置拉回。 */
function outputWheel(event) {
  if (event.deltaY < 0) followOutput.value = false
}

/** 用户明确点击后回到最新正文，随后继续跟随流式输出。 */
async function latestOutput() {
  followOutput.value = true
  await nextTick()
  const container = generatedText.value
  if (container) container.scrollTop = container.scrollHeight
}

/**
 * 读取当前用户已保存的生成参数，供后续直接复用。
 */
async function loadConfigs() {
  try {
    saved.value = await api('/generation-configs')
  } catch (e) {
    reportError(e)
  }
}

/** 从数据库找回未完成剧本，页面刷新后不依赖内存中的任务标识。 */
async function loadRecoverables() {
  recovering.value = true
  try {
    recoverables.value = await api('/ai/recoverable')
  } catch (e) {
    if (!error.value) error.value = e.message
  } finally {
    recovering.value = false
  }
}

/** 删除未完成稿沿用作者软删除接口，取消公开与审核状态后移出待续创作列表。 */
async function deleteRecoverable(item) {
  if (!(await confirmAction('删除未完成剧本《' + item.title + '》？已生成的分集也将从剧本库移除。'))) return
  deleting.value = item.id
  try {
    await api('/scripts/' + item.id, { method: 'DELETE' })
    if (Number(scriptId.value) === item.id) {
      scriptId.value = null
      resumeId.value = null
      jobId.value = null
      output.value = ''
      done.value = false
      completed.value = 0
      await router.replace('/create')
    }
    await loadRecoverables()
    success('已删除未完成剧本')
  } catch (e) {
    reportError(e)
  } finally {
    deleting.value = null
  }
}

/** 随机模式使用当前模型填满全部参数；只接收完整成功结果，不自动生成或发布剧本。 */
async function randomizeStory() {
  if (randomizing.value || running.value || resumeId.value) return
  if ((title.value.trim() || params.value.theme.trim()) && !(await confirmAction('AI 将重新填写全部故事设定，是否替换当前参数？'))) return
  randomizing.value = true
  randomController = new AbortController()
  let configuration
  try {
    await streamApi(
      '/ai/configuration',
      { selection: selection.value },
      (event, data) => {
        if (event === 'done') configuration = data.configuration
        if (event === 'error' || event === 'cancelled') throw new Error(data.message || '随机设定已停止')
      },
      randomController.signal
    )
    if (!configuration) throw new Error('未收到完整故事设定，请重试；原参数已保留')
    if (!pageActive) return
    title.value = configuration.title
    applyParams(configuration.params)
    success('AI 已填写全部故事设定，可修改后生成剧本')
    await tasks.refresh()
  } catch (e) {
    if (e.name !== 'AbortError' && pageActive) reportError(e)
  } finally {
    randomizing.value = false
  }
}

/** 从任务中心找回已完成的随机设定；只读取本人任务，不再次调用模型。 */
async function restoreConfiguration(id) {
  if (running.value || randomizing.value) return
  const task = await api('/ai/jobs/' + id)
  if (task.operation !== 'randomize' || task.status !== 'completed') return
  const configuration = JSON.parse(task.output)
  title.value = configuration.title
  applyParams(configuration.params)
  scriptId.value = null
  resumeId.value = null
  jobId.value = null
  output.value = ''
  done.value = false
  completed.value = 0
}

/** 记录作品地址到当前路由，浏览器刷新仍能恢复同一部剧本。 */
function rememberScript(id) {
  scriptId.value = id
  resumeId.value = id
  if (pageActive && route.name === 'create' && String(route.query.resume) !== String(id))
    router.replace({ name: 'create', query: { resume: String(id), ...(jobId.value ? { job: jobId.value } : {}) } }).catch(() => {})
}

/** 以服务端分集为准恢复参数和完成数；续生成只补缺集，不覆盖已有正文。 */
async function restoreScript(id, showSavedOutput = true) {
  const s = await api('/scripts/' + id)
  const differentScript = Number(scriptId.value) !== Number(s.id)
  applyParams(s.config)
  title.value = s.title
  rememberScript(s.id)
  const progress = savedGenerationProgress(s)
  completed.value = progress.completed
  done.value = progress.done
  phase.value = done.value ? '全部分集已保存，可打开编辑器' : '已恢复创作，可继续生成剩余分集'
  if (showSavedOutput && (differentScript || !output.value)) output.value = [s.outline, ...s.episodes.map((e) => e.title + '\n' + e.content_text)].filter(Boolean).join('\n\n')
  return s
}

/** 找回按钮只恢复作品，不自动发起模型请求。 */
async function recover(id) {
  recovering.value = true
  try {
    await restoreScript(id)
    error.value = ''
    success('已找回创作进度，请选择模型后继续生成')
  } catch (e) {
    error.value = e.message
  } finally {
    recovering.value = false
  }
}

/** 保留当前屏幕上的增量文本，数据库离线时也能复制备份。 */
async function copyOutput() {
  try {
    await navigator.clipboard.writeText(output.value)
    success('当前输出已复制')
  } catch (e) {
    reportError(e)
  }
}

/**
 * 收集配置名称，保存当前创作参数并刷新配置列表。
 */
async function saveConfig() {
  const name = await askText('保存生成参数', '给这份创作设定起个名字')
  if (!name) return
  try {
    await api('/generation-configs', { method: 'POST', body: { name, params: params.value } })
    success('参数已保存')
    await loadConfigs()
  } catch (e) {
    reportError(e)
  }
}

/**
 * 删除指定的个人参数配置，成功后刷新列表。
 */
async function removeConfig(c) {
  try {
    await api('/generation-configs/' + c.id, { method: 'DELETE' })
    await loadConfigs()
  } catch (e) {
    reportError(e)
  }
}

/**
 * 统一载入旧配置、模板与续写配置；旧数据没有 styleNote 时补齐默认值。
 */
function applyParams(value) {
  params.value = { ...defaultParams(), ...JSON.parse(JSON.stringify(value || {})) }
  customStyleMode.value = Boolean(params.value.styleNote?.trim())
}

/**
 * 选择预设会清除补充风格，保证生成提示只采用当前可见的选择。
 */
function selectPresetStyle(style) {
  params.value.style = style
  params.value.styleNote = ''
  customStyleMode.value = false
}

/**
 * 开启自定义输入，不改变用于作品分类的预设题材。
 */
function enableCustomStyle() {
  customStyleMode.value = true
}

/**
 * 复制所选配置到表单并退出续生成模式，避免复用参数时仍关联旧剧本。
 */
function useConfig(c) {
  // 配置来自 Vue 响应式对象，以 JSON 数据克隆避免直接克隆 Proxy。
  applyParams(c.params)
  configOpen.value = false
  resumeId.value = null
  scriptId.value = null
  done.value = false
  router.replace('/create')
  success('已载入参数配置')
}

/**
 * 发起或继续剧本生成，并按 SSE 事件更新阶段、增量正文和已完成集数。
 * 继续生成时传已有 scriptId，服务端负责跳过已保存分集；本地仅展示过程。
 * 只有收到明确的 done、error 或 cancelled 才视为正常终结，提前断流会提示检查已保存内容。
 */
async function generate(resume = false) {
  if (randomizing.value || deleting.value) return
  if (running.value || recovering.value) return
  if (!selection.value) return reportError(new Error('请先选择已启用的供应商和模型'))
  if (resume && scriptId.value) {
    recovering.value = true
    try {
      await restoreScript(scriptId.value, false)
    } catch (e) {
      error.value = e.message
      return
    } finally {
      recovering.value = false
    }
    if (done.value) return
  }
  if (!title.value.trim() || !params.value.theme.trim()) {
    reportError(new Error('请先填写剧本名称与故事主题'))
    return
  }
  if (customStyleMode.value && !params.value.styleNote.trim()) {
    reportError(new Error('请填写自定义剧本风格'))
    return
  }
  running.value = true
  done.value = false
  followOutput.value = true
  output.value = resume && output.value ? output.value + '\n\n—— 继续生成剩余分集 ——\n\n' : ''
  error.value = ''
  completed.value = resume ? completed.value : 0
  jobId.value = null
  try {
    const result = await api('/ai/generate', {
      method: 'POST',
      body: {
        title: title.value,
        params: params.value,
        selection: selection.value,
        background: true,
        ...(resume && scriptId.value ? { scriptId: scriptId.value } : {})
      }
    })
    jobId.value = result.jobId
    activeModel.value = result.providerName + ' / ' + result.model
    if (pageActive && route.name === 'create') await router.replace({ name: 'create', query: { job: result.jobId, ...(scriptId.value ? { resume: scriptId.value } : {}) } })
    await tasks.refresh()
    await pollJob()
  } catch (e) {
    error.value = e.message
    running.value = false
  }
}

/**
 * 请求服务端取消当前任务，等待 SSE 收尾通知；已结束任务不重复报错。
 */
async function stop() {
  try {
    if (jobId.value) await api('/ai/jobs/' + jobId.value + '/cancel', { method: 'POST' })
  } catch (e) {
    if (e.code !== 'JOB_NOT_RUNNING') reportError(e)
  }
}

// 页面卸载不会取消后台任务；这里只订阅任务中心刷新，重新进入可继续观察。
let polling = false
let liveStream = null

/** 独立观察后台任务的实时文字流；离开只断开观察，重连先恢复完整输出。 */
function observeJob(id) {
  if (liveStream?.id === id || !pageActive) return
  liveStream?.controller.abort()
  const connection = { id, controller: new AbortController() }
  liveStream = connection
  streamApi(
    '/ai/jobs/' + id + '/events',
    undefined,
    (event, data) => {
      if (!pageActive || id !== jobId.value) return
      if (event === 'snapshot') {
        error.value = ''
        output.value = data.output || ''
        running.value = data.status === 'running'
        done.value = data.status === 'completed'
        phase.value = data.progress?.message || phase.value
        completed.value = data.progress?.completed || 0
        if (data.progress?.scriptId) rememberScript(data.progress.scriptId)
      } else if (event === 'delta') output.value += data.text
      else {
        if (data.scriptId) rememberScript(data.scriptId)
        if (data.message) phase.value = data.message
        if (data.completed !== undefined) completed.value = data.completed
        if (['done', 'error', 'cancelled'].includes(event)) {
          running.value = false
          done.value = event === 'done'
          if (event === 'error') error.value = data.message || '生成中断，可继续生成'
        }
      }
    },
    connection.controller.signal,
    'GET'
  )
    .catch((e) => {
      // 网络断流由任务轮询补偿并重订阅，不将观察连接失败误判为生成失败。
      if (e.name !== 'AbortError' && pageActive) console.warn('生成观察连接中断，等待重连')
    })
    .finally(() => {
      if (liveStream === connection) {
        liveStream = null
        if (pageActive) {
          tasks.refresh()
          if (!running.value) pollJob()
        }
      }
    })
}

/** 从服务端读取增量与实际完成数，连接暂时失败不等同任务失败。 */
async function pollJob() {
  if (!jobId.value || polling || (running.value && liveStream?.id === jobId.value)) return
  const id = jobId.value
  polling = true
  try {
    const task = await api('/ai/jobs/' + id)
    if (!pageActive || id !== jobId.value) return
    if (task.progress?.scriptId || task.script_id) rememberScript(task.progress?.scriptId || task.script_id)
    if (task.output && !liveStream) output.value = task.output
    phase.value = task.progress?.message || (task.status === 'running' ? '正在后台生成' : '任务已结束')
    completed.value = task.progress?.completed || 0
    running.value = task.status === 'running'
    done.value = task.status === 'completed'
    if (task.status === 'failed') error.value = task.progress?.message || '任务中断，可检查已保存分集后继续生成'
    if (task.status !== 'running') await loadRecoverables()
    else observeJob(id)
  } catch (e) {
    error.value = e.message + '；后台任务状态可在任务中心重新查看'
  } finally {
    polling = false
  }
}

watch(
  () => tasks.revision,
  () => {
    if (running.value) pollJob()
  }
)
watch(
  () => route.query.job,
  (id) => {
    if (id && id !== jobId.value) {
      jobId.value = String(id)
      pollJob()
    }
  }
)
watch(
  () => route.query.configuration,
  (id) => {
    if (id) restoreConfiguration(id).catch(reportError)
  }
)

// 初始化已存配置，并根据路由参数套用模板或加载待续写剧本。
onMounted(async () => {
  await loadConfigs()
  await loadRecoverables()
  try {
    if (route.query.configuration) await restoreConfiguration(route.query.configuration)
    if (route.query.template) {
      const t = await api('/templates/' + route.query.template + '/apply', { method: 'POST' })
      applyParams(t.params)
      success('已套用模板，可补充人物和主题')
    }
    if (route.query.resume) await restoreScript(route.query.resume)
    await tasks.refresh()
    const activeJob = tasks.items.find((t) => t.operation === 'generate' && t.status === 'running' && (t.script_id === scriptId.value || t.progress?.scriptId === scriptId.value))
    if (route.query.job || activeJob) {
      jobId.value = String(route.query.job || activeJob.id)
      await pollJob()
    }
  } catch (e) {
    reportError(e)
  }
})
</script>
<template>
  <PageHeading title="把灵感，写成下一幕。" description="先设计人物与目标，再让 AI 陪你完成故事。" eyebrow="FROM AN IDEA TO A STORY">
    <el-button @click="configOpen = true">
      <el-icon><FolderOpened /></el-icon>
      我的参数配置
    </el-button>
  </PageHeading>
  <section v-if="!running && recoverables.length" class="panel recovery-panel">
    <div class="panel-heading">
      <h2>未完成的创作</h2>
      <el-button :loading="recovering" @click="loadRecoverables">刷新进度</el-button>
    </div>
    <div v-for="item in recoverables.slice(0, 5)" :key="item.id" class="recovery-item">
      <span>
        {{ item.title }}
        <small>已保存 {{ item.completed }} / {{ item.target }} 集</small>
      </span>
      <div class="recovery-actions">
        <el-button :disabled="recovering || !!deleting || randomizing" @click="recover(item.id)">{{ scriptId === item.id ? '重新读取已保存进度' : '找回并继续创作' }}</el-button>
        <el-button type="danger" plain :loading="deleting === item.id" :disabled="!!deleting && deleting !== item.id" @click="deleteRecoverable(item)">
          <el-icon><Delete /></el-icon>
          删除
        </el-button>
      </div>
    </div>
  </section>
  <el-alert v-if="!auth.capabilities.aiConfigured" title="尚无可用模型" description="请在 API 配置中添加供应商，并启用至少一个模型。" type="info" :closable="false" show-icon />
  <div class="workflow-strip">
    <span class="current">01 构思故事</span>
    <i></i>
    <span :class="{ current: running || done }">02 生成初稿</span>
    <i></i>
    <span>03 编辑打磨</span>
    <i></i>
    <span>04 保存与分享</span>
  </div>
  <div class="creation-layout">
    <section class="panel config-panel">
      <div class="panel-heading">
        <h2>
          <el-icon class="leading-icon" aria-hidden="true"><MagicStick /></el-icon>
          故事设定
        </h2>
      </div>
      <el-form label-position="top">
        <el-form-item label="生成模型"><ModelSelector v-model="selection" :disabled="running || randomizing" /></el-form-item>
      </el-form>
      <div class="random-story-mode">
        <el-button :loading="randomizing" :disabled="running || !!resumeId || !auth.capabilities.aiConfigured" @click="randomizeStory">
          <el-icon><MagicStick /></el-icon>
          {{ randomizing ? 'AI 正在构思设定' : '随机模式 · AI 填写全部参数' }}
        </el-button>
        <p class="fine muted">使用上方模型随机构思；填写后可自由调整，再生成正文。{{ resumeId ? '续创作保留原设定，新建剧本后可使用。' : '' }}</p>
      </div>
      <el-form label-position="top" :disabled="running || randomizing || !!resumeId">
        <el-form-item label="剧本名称"><el-input v-model="title" placeholder="给你的故事起一个名字" maxlength="120" /></el-form-item>
        <el-form-item label="故事主题"><el-input v-model="params.theme" type="textarea" :rows="3" maxlength="1000" show-word-limit placeholder="主角想要什么？又遇到了什么阻碍？" /></el-form-item>
        <el-form-item label="剧本风格">
          <div class="genre-buttons">
            <button
              v-for="g in genres"
              :key="g"
              type="button"
              :disabled="running || randomizing || !!resumeId"
              :class="{ selected: !customStyleMode && params.style === g }"
              @click="selectPresetStyle(g)">
              {{ g }}
            </button>
            <button type="button" :disabled="running || randomizing || !!resumeId" :class="{ selected: customStyleMode }" @click="enableCustomStyle">自定义</button>
          </div>
        </el-form-item>
        <el-form-item v-if="customStyleMode" label="自定义剧本风格">
          <el-input v-model="params.styleNote" type="textarea" :rows="2" maxlength="1000" show-word-limit placeholder="例如：赛博朋克悬疑、黑色幽默、现实主义职场群像、轻喜剧节奏" />
          <div class="form-tip">此内容会与“{{ params.style }}”题材一起发送给 AI，不影响剧本库的题材分类。</div>
        </el-form-item>
        <el-form-item label="人物设定"><el-input v-model="params.people" type="textarea" :rows="3" maxlength="3000" placeholder="姓名、身份、动机与人物关系" /></el-form-item>
        <el-form-item label="故事背景"><el-input v-model="params.background" type="textarea" :rows="2" maxlength="3000" /></el-form-item>
        <div class="form-two">
          <el-form-item label="计划集数"><el-input-number v-model="params.episodes" :min="1" :max="80" /></el-form-item>
          <el-form-item label="单集时长（分钟）"><el-input-number v-model="params.duration" :min="1" :max="10" /></el-form-item>
        </div>
        <el-form-item label="反转与爽点要求"><el-input v-model="params.twist" type="textarea" :rows="3" maxlength="3000" /></el-form-item>
      </el-form>
      <p v-if="resumeId" class="fine muted">继续生成使用该剧本保存时的原始参数，避免人物与情节不一致。</p>
      <div class="form-actions">
        <el-button @click="saveConfig" :disabled="running || randomizing">保存配置</el-button>
        <el-button type="primary" :loading="running" :disabled="randomizing || !auth.capabilities.aiConfigured || (done && !!resumeId)" @click="generate(!!resumeId)">
          {{ done && resumeId ? '全部分集已完成' : resumeId ? '继续生成剩余分集' : '生成整部剧本' }}
        </el-button>
      </div>
      <el-button
        v-if="resumeId && !running && !randomizing"
        text
        @click="
          () => {
            resumeId = null
            scriptId = null
            output = ''
            done = false
            router.replace('/create')
          }
        ">
        用当前参数新建另一部剧本
      </el-button>
      <p class="fine muted">先生成大纲，再逐集生成正文；集数越多耗时和模型调用费用越高。</p>
    </section>
    <section class="panel generation-panel">
      <div class="panel-heading">
        <h2>
          <el-icon><Document /></el-icon>
          剧本初稿
        </h2>
        <span class="live-model">
          <i></i>
          {{ running ? activeModel : selection?.model || '未选择模型' }}
        </span>
      </div>
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <div v-if="!running && (error || (scriptId && !done))" class="recovery-actions">
        <el-button v-if="scriptId && !done" type="primary" :disabled="!selection || recovering" @click="generate(true)">继续生成</el-button>
        <el-button v-if="!scriptId && error" type="primary" :disabled="!selection" @click="generate(false)">重试生成</el-button>
        <el-button v-if="output" @click="copyOutput">复制当前输出</el-button>
        <el-button :loading="recovering" @click="loadRecoverables">检查已保存进度</el-button>
      </div>
      <div v-if="!output" class="generation-empty">
        <div class="empty-magic" aria-hidden="true">
          <el-icon><EditPen /></el-icon>
        </div>
        <h3>你的故事，即将开场</h3>
        <p>
          {{ phase }}
          <br />
          每一段精彩，都从一个大胆的想法开始。
        </p>
        <div class="empty-prompts">
          <span>
            <el-icon aria-hidden="true"><User /></el-icon>
            鲜活人物
          </span>
          <span>
            <el-icon aria-hidden="true"><Connection /></el-icon>
            冲突与动机
          </span>
          <span>
            <el-icon aria-hidden="true"><Switch /></el-icon>
            合理反转
          </span>
        </div>
      </div>
      <div
        ref="generatedText"
        v-else
        class="generated-text"
        aria-live="polite"
        tabindex="0"
        aria-label="剧本初稿内容"
        @scroll.passive="outputScrolled"
        @wheel.passive="outputWheel"
        @touchstart.passive="followOutput = false"
        @keydown="
          (event) => {
            if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) followOutput = false
          }
        ">
        <div class="output-label">
          AI 实时输出
          <span>{{ phase }}</span>
        </div>
        <pre>{{output}}<span v-if="running" class="typing-cursor">▍</span></pre>
      </div>
      <div v-if="output && !followOutput" class="output-follow-control">
        <span>{{ running ? '已暂停自动跟随，可自由阅读上文' : '正在查看上文' }}</span>
        <el-button size="small" @click="latestOutput">
          <el-icon><ArrowDown /></el-icon>
          回到最新内容
        </el-button>
      </div>
      <div class="generation-bottom">
        <el-progress :percentage="done ? 100 : Math.min(99, Math.round((completed / params.episodes) * 100))" :show-text="false" />
        <div>
          <span>{{ phase }} · 已完成 {{ completed }} / {{ params.episodes }} 集</span>
          <el-tag v-if="running" type="info">后台运行中，可自由切换页面</el-tag>
          <el-button v-if="running" @click="stop">停止生成</el-button>
          <el-button v-if="scriptId && !running" type="primary" @click="router.push('/scripts/' + scriptId)">
            打开编辑器
            <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
          </el-button>
        </div>
      </div>
    </section>
  </div>
  <el-drawer v-model="configOpen" title="我的生成参数" size="420px">
    <el-empty v-if="!saved.length" description="还没有保存参数" />
    <div v-for="c in saved" :key="c.id" class="snapshot">
      <div>
        <b>{{ c.name }}</b>
        <span>{{ dateLabel(c.created_at) }}</span>
      </div>
      <p>{{ c.params.theme }}</p>
      <el-button @click="useConfig(c)" :disabled="running || randomizing">复用配置</el-button>
      <el-button text type="danger" @click="removeConfig(c)">删除</el-button>
    </div>
  </el-drawer>
</template>
<style scoped>
.random-story-mode {
  padding: 14px;
  margin-bottom: 20px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--el-fill-color-light);
}
.random-story-mode .el-button {
  width: 100%;
}
.random-story-mode p {
  margin: 10px 0 0;
}
.recovery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  flex-shrink: 0;
}
.recovery-actions .el-button + .el-button {
  margin-left: 0;
}
/* 参数与输出独立布局：拉伸输入框只影响左列，右列保持视口高度并在内部滚动。 */
.creation-layout {
  align-items: start;
}
.creation-layout .config-panel {
  min-width: 0;
}
.creation-layout .generation-panel {
  position: sticky;
  top: calc(var(--app-header-height, 73px) + 12px);
  height: clamp(520px, calc(100dvh - 100px), 860px);
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.generation-panel > .panel-heading,
.generation-panel .generation-bottom {
  flex-shrink: 0;
}
.generation-panel .generated-text {
  overflow-anchor: none;
  scroll-behavior: auto;
  min-height: 0;
  max-height: none;
}
.output-follow-control {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding-bottom: 10px;
  font-size: 14px;
  color: var(--el-text-color-secondary);
}
.generation-panel .generation-bottom > div + div {
  flex-wrap: wrap;
}
@media (max-width: 1000px) {
  .creation-layout .generation-panel {
    position: static;
    height: 640px;
    max-height: 85dvh;
  }
}
.recovery-panel {
  margin-bottom: 20px;
}
.recovery-item {
  display: flex;
  gap: 16px;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
}
.recovery-item small {
  color: var(--el-text-color-secondary);
  margin-left: 12px;
}
.recovery-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 15px 0;
}
</style>
