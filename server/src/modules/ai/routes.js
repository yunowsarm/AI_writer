/** AI 任务模块：可停止的流、持久化状态、逐集落库、局部改写候选。 */
import { Router } from 'express'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { q, transaction, json } from '../../db/index.js'
import { requireUser } from '../auth/service.js'
import { getAiSettings } from '../settings/service.js'
import { selectionSchema } from '../settings/providers.js'
import { ensure } from '../../shared/errors.js'
import { paramsSchema, idSchema } from '../../shared/validation.js'
import { createScript, ownedScript, ownedEpisode, addVersion } from '../scripts/service.js'
import { textToHtml } from '../../shared/content.js'
import { trackedCompletion } from '../usage/service.js'
import { outlinePrompt, episodePrompt, rewritePrompt } from './prompts.js'
import { finishFailedJob } from './failure.js'
import { randomConfiguration } from './configuration.js'
import { appendEpisode } from './appendEpisode.js'
export const aiRouter = Router()
aiRouter.use(requireUser)
aiRouter.post('/scripts/:id/episodes', (req, res) => appendEpisode(req, res, startJob))
const active = new Map()

/**
 * 判断指定用户是否仍有运行中的 AI 任务，仅限制本人配置修改，不阻塞其他用户。
 */
export const hasActiveJobs = (userId) => [...active.values()].some((job) => job.userId === userId)

/**
 * 服务退出时通知本进程内所有 AI 任务取消，由各任务负责后续收尾。
 */
export function cancelAll() {
  for (const t of active.values()) t.controller.abort()
}

/** POST /api/ai/configuration：本人选定模型随机填写故事参数，SSE 返回完整 configuration；计入本人用量，不自动生成正文。 */
aiRouter.post('/configuration', async (req, res) => {
  const body = z.object({ selection: selectionSchema.optional() }).parse(req.body)
  const job = await startJob(req, res, 'randomize', { ...body, title: 'AI 随机故事设定' })
  try {
    job.send('phase', { message: 'AI 正在构思人物、主题与完整故事设定', total: 1, completed: 0 })
    const configuration = await randomConfiguration(job)
    await q("UPDATE ai_jobs SET status='completed',output=? WHERE id=?", [JSON.stringify(configuration), job.id])
    job.send('done', { configuration, message: '随机故事设定已完成，可调整后生成剧本' })
  } catch (e) {
    await finishFailedJob(job, e)
  } finally {
    await job.finish()
  }
})

/** GET /api/ai/recoverable：列出本人最近未完成的生成稿，刷新后仍可找回缺失分集。 */
aiRouter.get('/recoverable', async (req, res) => {
  const rows = await q(
    `SELECT s.id,s.title,CAST(JSON_UNQUOTE(JSON_EXTRACT(s.config_json,'$.episodes')) AS UNSIGNED) target,
    (SELECT COUNT(*) FROM episodes e WHERE e.script_id=s.id AND e.episode_no BETWEEN 1 AND CAST(JSON_UNQUOTE(JSON_EXTRACT(s.config_json,'$.episodes')) AS UNSIGNED)) completed
    FROM scripts s WHERE s.owner_id=? AND s.deleted_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(s.config_json,'$.theme')) IS NOT NULL
    HAVING target BETWEEN 1 AND 80 AND completed<target ORDER BY s.updated_at DESC LIMIT 20`,
    [req.user.id]
  )
  res.set('Cache-Control', 'no-store').json(rows)
})

/**
 * 创建可取消的 AI 任务并初始化 SSE 响应，返回发送和收尾句柄。
 * 在第一次异步查询前占用用户槽位；记录当前模型配置快照，避免生成中途配置漂移。
 * SSE 候选断开会取消上游；background=true 返回202，关闭页面不取消任务。
 * finish 等待阶段快照保存，再清理心跳、事件监听和运行槽位。
 */
export async function startJob(req, res, operation, params, scriptId) {
  ensure(![...active.values()].some((j) => j.userId === req.user.id), 409, 'AI_JOB_ACTIVE', '你已有一个 AI 任务正在运行，可在任务中心查看或停止')
  const id = randomUUID(),
    controller = new AbortController()
  let settings
  // 在任何异步查询之前占用用户槽位，防止两个并发请求同时通过检查。
  const state = { title: params.title || '', message: '正在准备任务', completed: 0, total: params.params?.episodes || 0, scriptId: scriptId || null, reportId: null, output: '', status: 'running' }
  const listeners = new Set()
  active.set(id, { controller, userId: req.user.id, state, listeners })
  try {
    settings = await getAiSettings(req.user.id, params.selection)
    ensure(settings.key, 503, 'AI_NOT_CONFIGURED', '请先在个人 API 配置页面填写你自己的 DeepSeek Key')
    const [count] = await q('SELECT COUNT(*) n FROM ai_jobs WHERE user_id=? AND created_at>DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 HOUR)', [req.user.id])
    ensure(count.n < 30, 429, 'AI_QUOTA', '每小时最多发起 30 次 AI 任务')
    params = { ...params, selection: { providerId: settings.providerId, model: settings.model }, providerBaseUrl: settings.baseUrl, apiFormat: settings.apiFormat || 'openai-chat' }
    await q('INSERT INTO ai_jobs(id,user_id,script_id,operation,params,status,output,model) VALUES(?,?,?,?,?,?,?,?)', [
      id,
      req.user.id,
      scriptId || null,
      operation,
      JSON.stringify(params),
      'running',
      '',
      settings.model
    ])
  } catch (e) {
    active.delete(id)
    throw e
  }
  const background = params.background === true
  if (!background) {
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders()
  }
  let sequence = 0,
    pending = Promise.resolve()
  // 任务状态与浏览器连接解耦；增量仅在内存累积，阶段和终态持久化。
  const send = (event, data) => {
    if (data.scriptId) state.scriptId = data.scriptId
    if (data.episodeId) state.episodeId = data.episodeId
    if (data.reportId) state.reportId = data.reportId
    if (data.message) state.message = data.message
    if (data.completed !== undefined) state.completed = data.completed
    if (data.total !== undefined) state.total = data.total
    if (event === 'delta') state.output += data.text
    if (['done', 'error', 'cancelled'].includes(event)) {
      state.status = event === 'done' ? 'completed' : event === 'error' ? 'failed' : 'cancelled'
      if (event === 'done') {
        state.completed = state.total
        state.message = data.message || (operation === 'evaluate' ? (data.status === 'partial' ? '评估部分完成，请查看报告中的未完成项目' : '评估已完成') : '生成已完成')
        state.resultStatus = data.status
      }
      state.code = data.code
    }
    if (!background && !res.destroyed) res.write(`id: ${++sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    for (const listener of listeners) listener(event, data)
    if (!['delta', 'start'].includes(event)) {
      const snapshot = JSON.stringify({ ...state, output: undefined })
      pending = pending.then(() => q('UPDATE ai_jobs SET progress_json=? WHERE id=?', [snapshot, id])).catch((error) => console.warn('[AI_PROGRESS_SAVE]', error.code || error.name))
    }
  }
  const close = () => {
    if (!background && !res.writableEnded) controller.abort()
  }
  if (!background) res.on('close', close)
  const heartbeat = background
    ? null
    : setInterval(() => {
        if (!res.destroyed) res.write(': keep-alive\n\n')
      }, 15000)
  const meta = { jobId: id, scriptId, model: settings.model, providerName: settings.providerName }
  if (background) res.status(202).json(meta)
  else send('start', meta)
  return {
    id,
    settings,
    userId: req.user.id,
    controller,
    send,
    finish: async () => {
      if (heartbeat) clearInterval(heartbeat)
      await pending
      for (const listener of listeners) listener('end', {})
      listeners.clear()
      active.delete(id)
      res.off('close', close)
      if (!background) res.end()
    }
  }
}

/**
 * GET /api/ai/jobs
 * 用途：读取当前用户最近 30 条 AI 任务摘要。
 * 权限：已登录用户，仅本人任务。
 * 入参：无。
 * 返回：任务 ID、剧本 ID、操作、状态、模型和错误码等摘要。
 */
aiRouter.get('/jobs', async (req, res) => {
  const running = await q("SELECT id FROM ai_jobs WHERE user_id=? AND status='running'", [req.user.id])
  const staleIds = running.filter((job) => !active.has(job.id)).map((job) => job.id)
  // 数据库离线时未能写入的任务收尾，在连接恢复后按内存活动任务校正，不影响仍在生成的任务。
  if (staleIds.length)
    await q(`UPDATE ai_jobs SET status='failed',error_code='TASK_INTERRUPTED' WHERE user_id=? AND status='running' AND id IN (${staleIds.map(() => '?').join(',')})`, [req.user.id, ...staleIds])
  await q(
    "UPDATE ai_requests r JOIN ai_jobs j ON j.id=r.job_id SET r.status='failed',r.error_code='TASK_INTERRUPTED',r.finished_at=UTC_TIMESTAMP(3) WHERE j.user_id=? AND j.status='failed' AND r.status='running'",
    [req.user.id]
  )
  const rows = await q('SELECT id,script_id,operation,status,model,error_code,created_at,progress_json FROM ai_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 30', [req.user.id])
  res
    .set('Cache-Control', 'no-store')
    .json(rows.map((row) => ({ ...row, progress_json: undefined, progress: active.get(row.id)?.state ? { ...active.get(row.id).state, output: undefined } : json(row.progress_json) })))
})

/**
 * GET /api/ai/jobs/:id/events
 * 用途：订阅后台任务的完整首帧、实时文字增量与阶段变化。
 * 权限：已登录任务发起人。
 * 入参：Path：id，UUID。
 * 返回：SSE snapshot、delta、phase、progress、episode、done/error/cancelled。
 * 断开观察连接不会停止后台任务，重新进入时先恢复完整文字。
 */
aiRouter.get('/jobs/:id/events', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id)
  const [row] = await q('SELECT status,output,progress_json FROM ai_jobs WHERE id=? AND user_id=?', [id, req.user.id])
  ensure(row, 404, 'JOB_NOT_FOUND', '任务不存在')
  const job = active.get(id)
  res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const write = (event, data) => {
    if (event === 'end') return res.end()
    if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  // 注册与首帧之间不 await，避免初始全文和增量之间漏字或重复。
  job?.listeners.add(write)
  write('snapshot', { output: job?.state.output ?? row.output, progress: job ? { ...job.state, output: undefined } : json(row.progress_json), status: job?.state.status || row.status })
  if (!job) return res.end()
  const heartbeat = setInterval(() => {
    if (!res.destroyed) res.write(': keep-alive\n\n')
  }, 15000)
  res.on('close', () => {
    clearInterval(heartbeat)
    job.listeners.delete(write)
  })
})

/** GET /api/ai/jobs/:id：读取本人任务详情、输出和进度；用于任务中心与流式断连后的状态补偿。 */
aiRouter.get('/jobs/:id', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id)
  const rows = await q('SELECT * FROM ai_jobs WHERE id=? AND user_id=?', [id, req.user.id])
  ensure(rows.length, 404, 'JOB_NOT_FOUND', '任务不存在')
  const live = active.get(id)?.state
  res
    .set('Cache-Control', 'no-store')
    .json({ ...rows[0], progress_json: undefined, progress: live ? { ...live, output: undefined } : json(rows[0].progress_json), output: live?.output || rows[0].output })
})

/**
 * POST /api/ai/jobs/:id/cancel
 * 用途：中止本人当前运行的 AI 任务。
 * 权限：已登录任务发起人，仅内存中仍运行的任务。
 * 入参：Path：id，UUID。
 * 返回：ok；最终取消状态由流式任务的收尾逻辑落库。
 */
aiRouter.post('/jobs/:id/cancel', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id)
  const job = active.get(id)
  ensure(job?.userId === req.user.id, 404, 'JOB_NOT_RUNNING', '任务不存在或已经结束')
  job.controller.abort()
  res.json({ ok: true })
})

/**
 * POST /api/ai/generate
 * 用途：流式创作剧本：先大纲后逐集生成，支持继续已有作品的缺失集。
 * 权限：已登录用户，须配置 AI；每用户限一个运行任务及每小时 30 个任务。
 * 入参：Body：params、title，可选 scriptId；继续时采用已保存的剧本配置。
 * 返回：SSE：start、script、phase、delta、episode、done 或 cancelled/error。
 */
aiRouter.post('/generate', async (req, res) => {
  const b = z
    .object({ params: paramsSchema, title: z.string().trim().min(1).max(120), scriptId: idSchema.optional(), selection: selectionSchema.optional(), background: z.boolean().default(false) })
    .parse(req.body)
  if (b.scriptId) {
    const existing = await ownedScript(b.scriptId, req.user.id)
    paramsSchema.parse(json(existing.config_json))
  }
  const job = await startJob(req, res, 'generate', b, b.scriptId)
  let output = '',
    scriptId = b.scriptId
  try {
    // 先生成大纲，再依次生成正文；每一集完整结束后在事务中保存。
    if (!scriptId) {
      scriptId = await createScript(req.user.id, {
        title: b.title,
        genre: b.params.style,
        synopsis: b.params.theme,
        config: b.params
      })
      // 剧本创建成功立即发出标识，即使后续任务关联写入失败，页面也能找回作品。
      job.send('script', { scriptId })
      await q('UPDATE ai_jobs SET script_id=? WHERE id=?', [scriptId, job.id])
    }
    job.send('script', { scriptId })
    const s = await ownedScript(scriptId, req.user.id)
    const params = b.scriptId ? paramsSchema.parse(json(s.config_json)) : b.params
    let outline = s.outline
    if (!outline) {
      job.send('phase', { phase: 'outline', message: '正在构建人物关系与分集大纲' })
      outline = await trackedCompletion(job, outlinePrompt(params), {
        phase: 'outline',
        settings: job.settings,
        signal: job.controller.signal,
        onDelta: (t) => {
          output += t
          job.send('delta', { text: t, phase: 'outline' })
        }
      })
      await q('UPDATE scripts SET outline=? WHERE id=?', [outline, scriptId])
    }
    const existing = await q('SELECT episode_no,content_text FROM episodes WHERE script_id=? ORDER BY episode_no', [scriptId])
    job.send('progress', { completed: existing.filter((e) => e.episode_no >= 1 && e.episode_no <= params.episodes).length, total: params.episodes })
    let previous = existing.at(-1)?.content_text || ''
    // 以已落库的集号判断进度，继续生成只补缺失分集，不覆盖已完成内容。
    const done = new Set(existing.map((e) => e.episode_no))
    for (let i = 1; i <= params.episodes; i++) {
      if (done.has(i)) continue
      job.controller.signal.throwIfAborted()
      job.send('phase', {
        phase: 'episode',
        episode: i,
        total: params.episodes,
        message: `正在创作第 ${i} 集`
      })
      const text = await trackedCompletion(job, episodePrompt(params, outline, i, previous), {
        phase: 'episode',
        episodeNo: i,
        settings: job.settings,
        signal: job.controller.signal,
        onDelta: (t) => {
          output += t
          job.send('delta', { text: t, phase: 'episode', episode: i })
        }
      })
      // 仅完整生成的一集进入事务，正文与首个版本快照必须同时保存成功。
      await transaction(async (db) => {
        const r = await q('INSERT INTO episodes(script_id,episode_no,title,content_html,content_text) VALUES(?,?,?,?,?)', [scriptId, i, `第 ${i} 集`, textToHtml(text), text], db)
        await addVersion(
          {
            id: r.insertId,
            document_json: null,
            content_html: textToHtml(text),
            content_text: text,
            revision: 1
          },
          'AI 生成',
          db
        )
      })
      previous = text
      done.add(i)
      job.send('episode', { episode: i, completed: [...done].filter((n) => n >= 1 && n <= params.episodes).length, total: params.episodes, scriptId })
      await q('UPDATE ai_jobs SET output=? WHERE id=?', [output, job.id])
    }
    await q("UPDATE ai_jobs SET status='completed',output=? WHERE id=?", [output, job.id])
    job.send('done', { scriptId })
  } catch (e) {
    await finishFailedJob(job, e, { output, scriptId })
  } finally {
    await job.finish()
  }
})

/**
 * POST /api/ai/rewrite
 * 用途：按选中内容流式续写、扩写、精简、风格改写或重新创作。
 * 权限：已登录作者，必须匹配分集当前 revision；受 AI 任务限额保护。
 * 入参：Body：episodeId、revision、operation、text，可选 style、instruction。
 * 返回：SSE 候选正文与原 revision；本接口不自动覆盖编辑器正文。
 */
aiRouter.post('/rewrite', async (req, res) => {
  const b = z
    .object({
      episodeId: idSchema,
      revision: z.number().int().positive(),
      operation: z.enum(['continue', 'expand', 'shorten', 'style', 'regenerate']),
      text: z.string().min(1).max(50000),
      style: z.string().max(100).default('更有冲突感'),
      instruction: z.string().max(1000).default(''),
      targetWords: z.number().int().min(10).max(12000).optional(),
      selection: selectionSchema.optional()
    })
    .parse(req.body)
  const e = await ownedEpisode(b.episodeId, req.user.id)
  // 发起时检查正文版本；完成后把同一 revision 交回前端，应用候选前再次核对。
  ensure(e.revision === b.revision, 409, 'REVISION_CONFLICT', '正文已更新，请重新选择内容')
  const job = await startJob(req, res, b.operation, b, e.script_id)
  let output = ''
  try {
    output = await trackedCompletion(job, rewritePrompt({ ...b, context: e.content_text }), {
      phase: 'rewrite',
      settings: job.settings,
      signal: job.controller.signal,
      onDelta: (t) => {
        output += t
        job.send('delta', { text: t })
      }
    })
    await q("UPDATE ai_jobs SET status='completed',output=? WHERE id=?", [output, job.id])
    job.send('done', { text: output, revision: e.revision })
  } catch (err) {
    await finishFailedJob(job, err, { output, scriptId: e.script_id })
  } finally {
    await job.finish()
  }
})
