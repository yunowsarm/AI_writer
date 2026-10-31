/** 质量评估接口：作者鉴权、不可变报告、内容过期检测与可取消 SSE 任务。 */
import { Router } from 'express'
import { z } from 'zod'
import { q, json } from '../../db/index.js'
import { requireUser } from '../auth/service.js'
import { ownedScript } from '../scripts/service.js'
import { idSchema } from '../../shared/validation.js'
import { ensure } from '../../shared/errors.js'
import { selectionSchema } from '../settings/providers.js'
import { getAiSettings } from '../settings/service.js'
import { finishFailedJob } from '../ai/failure.js'
import { startJob } from '../ai/routes.js'
import { qualitySnapshot, makeChunks, cachedReport, evaluate } from './service.js'
import { parseScript, fingerprint } from './algorithm.js'
import { remainingEvidence } from '../../../../shared/qualityResolution.js'
import { optimizationInput, runOptimization, applyOptimization } from './optimization.js'
import { estimatedReviewCalls } from './optimizationReview.js'

export const qualityRouter = Router()
qualityRouter.use(requireUser)

/** GET /api/quality/reports/:id/optimization-plan：汇总可处理段落和预计调用次数，不调用模型或修改正文。 */
qualityRouter.get('/reports/:id/optimization-plan', async (req, res) => {
  const input = await optimizationInput(z.string().uuid().parse(req.params.id), req.user.id)
  const { plan } = input
  res.set('Cache-Control', 'no-store').json({
    reportId: input.report.id,
    scriptId: input.script.id,
    title: input.script.title,
    fingerprint: plan.fingerprint,
    total: plan.total,
    aiCalls: plan.aiCalls,
    reviewCalls: estimatedReviewCalls(plan.changes),
    deletions: plan.deletions,
    skipped: plan.skipped
  })
})

/** POST /api/quality/reports/:id/optimize：冻结计划后后台生成候选，正文必须经单独确认应用接口才更新。 */
qualityRouter.post('/reports/:id/optimize', async (req, res) => {
  const body = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/), selection: selectionSchema.optional() }).parse(req.body)
  const input = await optimizationInput(z.string().uuid().parse(req.params.id), req.user.id)
  ensure(input.plan.total, 400, 'NOTHING_TO_OPTIMIZE', '没有可自动优化的位置，请查看待确认建议或重新评估')
  ensure(input.plan.fingerprint === body.fingerprint, 409, 'OPTIMIZATION_PLAN_CHANGED', '正文或处理状态已更新，请重新打开一键优化')
  const job = await startJob(req, res, 'optimize', { reportId: input.report.id, title: input.script.title, selection: body.selection, background: true }, input.script.id)
  try {
    await runOptimization(job, input)
  } catch (e) {
    await finishFailedJob(job, e, { scriptId: input.script.id, reportId: input.report.id })
  } finally {
    await job.finish()
  }
})

/** GET /api/quality/optimizations/:id：本人后台优化候选与应用状态；刷新页面后仍能找回。 */
qualityRouter.get('/optimizations/:id', async (req, res) => {
  const [job] = await q("SELECT id,status,output,script_id FROM ai_jobs WHERE id=? AND user_id=? AND operation='optimize'", [z.string().uuid().parse(req.params.id), req.user.id])
  ensure(job, 404, 'OPTIMIZATION_NOT_FOUND', '优化任务不存在或无权访问')
  await ownedScript(job.script_id, req.user.id)
  res.set('Cache-Control', 'no-store').json({ jobId: job.id, status: job.status, result: job.output ? json(job.output) : null })
})

/** POST /api/quality/optimizations/:id/apply：统一应用作者勾选的候选，冲突时整批回滚，不覆盖并发编辑。 */
qualityRouter.post('/optimizations/:id/apply', async (req, res) => {
  const body = z
    .object({
      changeIds: z.array(z.string().regex(/^e\d+-b\d+$/)).min(1),
      acknowledgedReviewIds: z.array(z.string().regex(/^e\d+-b\d+$/)).default([])
    })
    .parse(req.body)
  res.json(await applyOptimization(z.string().uuid().parse(req.params.id), req.user.id, body.changeIds, body.acknowledgedReviewIds))
})

/** GET /api/quality/scripts/:id/reports：读取本人剧本最近30份报告摘要及当前内容指纹。 */
qualityRouter.get('/scripts/:id/reports', async (req, res) => {
  const scriptId = idSchema.parse(req.params.id)
  const snapshot = await qualitySnapshot(scriptId, req.user.id)
  const rows = await q('SELECT id,status,model,provider_name,algorithm_version,fingerprint,created_at FROM quality_reports WHERE user_id=? AND script_id=? ORDER BY created_at DESC LIMIT 30', [
    req.user.id,
    scriptId
  ])
  const current = fingerprint(snapshot)
  res.set('Cache-Control', 'no-store').json(rows.map((row) => ({ ...row, stale: row.fingerprint !== current })))
})

/** GET /api/quality/reports/:id：返回本人报告、评估快照和是否已过期，不返回 API Key。 */
qualityRouter.get('/reports/:id', async (req, res) => {
  const [report] = await q('SELECT * FROM quality_reports WHERE id=? AND user_id=?', [z.string().uuid().parse(req.params.id), req.user.id])
  ensure(report, 404, 'QUALITY_NOT_FOUND', '报告不存在或无权访问')
  const current = await qualitySnapshot(report.script_id, req.user.id)
  const resolutions = await q('SELECT issue_id FROM quality_issue_resolutions WHERE report_id=? AND user_id=?', [report.id, req.user.id])
  const resolvedEvidence = await q('SELECT issue_id issueId,paragraph_id paragraphId FROM quality_evidence_resolutions WHERE report_id=? AND user_id=?', [report.id, req.user.id])
  const result = json(report.result_json)
  const ignored = await q('SELECT issue_id FROM quality_issue_ignores WHERE report_id=? AND user_id=?', [report.id, req.user.id])
  res.set('Cache-Control', 'no-store').json({
    ...report,
    snapshot: json(report.snapshot_json),
    result: result ? { ...result, analyses: undefined } : result,
    resolvedEvidence,
    ignoredIssues: ignored.map((r) => r.issue_id),
    resolvedIssues: [
      ...new Set([...resolutions.map((r) => r.issue_id), ...(result?.issues || []).filter((i) => i.evidence.length && !remainingEvidence(i, resolvedEvidence).length).map((i) => i.id)])
    ],
    snapshot_json: undefined,
    result_json: undefined,
    stale: fingerprint(current) !== report.fingerprint
  })
})

/** POST /api/quality/reports/:id/issues/:issue/ignore：仅作者可忽略或恢复本报告的建议，不改变正文、评分或已解决状态。 */
qualityRouter.post('/reports/:id/issues/:issue/ignore', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id)
  const issueId = z.string().min(1).max(40).parse(req.params.issue)
  const { ignored } = z.object({ ignored: z.boolean() }).parse(req.body)
  const [report] = await q('SELECT script_id,result_json FROM quality_reports WHERE id=? AND user_id=?', [id, req.user.id])
  ensure(report, 404, 'QUALITY_NOT_FOUND', '报告不存在或无权访问')
  await ownedScript(report.script_id, req.user.id)
  ensure(
    json(report.result_json)?.issues?.some((i) => i.id === issueId),
    404,
    'ISSUE_NOT_FOUND',
    '评估问题不存在'
  )
  if (ignored) await q('INSERT IGNORE INTO quality_issue_ignores(report_id,issue_id,user_id) VALUES(?,?,?)', [id, issueId, req.user.id])
  else await q('DELETE FROM quality_issue_ignores WHERE report_id=? AND issue_id=? AND user_id=?', [id, issueId, req.user.id])
  res.json({ ok: true, ignored })
})

/** POST /api/quality/scripts/:id/evaluate：评估保存快照；SSE返回实际完成块数，可复用相同完整报告。 */
qualityRouter.post('/scripts/:id/evaluate', async (req, res) => {
  const scriptId = idSchema.parse(req.params.id)
  await ownedScript(scriptId, req.user.id)
  const input = z.object({ selection: selectionSchema.optional(), background: z.boolean().default(false) }).parse(req.body)
  const snapshot = await qualitySnapshot(scriptId, req.user.id)
  const chunks = makeChunks(parseScript(snapshot))
  const settings = await getAiSettings(req.user.id, input.selection)
  const cached = await cachedReport(req.user.id, scriptId, snapshot, settings)
  if (cached) {
    if (input.background) return res.json({ reportId: cached, cached: true })
    res.set('Content-Type', 'text/event-stream; charset=utf-8').end(`event: done\ndata: ${JSON.stringify({ reportId: cached, cached: true })}\n\n`)
    return
  }
  const job = await startJob(req, res, 'evaluate', { ...input, title: snapshot.title }, scriptId)
  try {
    await evaluate(job, scriptId, snapshot, chunks)
  } catch (e) {
    await finishFailedJob(job, e, { scriptId })
  } finally {
    await job.finish()
  }
})

/** POST /api/quality/reports/:id/issues/:issue/resolve：有 paragraphId 时仅完成该证据，兼容旧客户端的整项标记。 */
qualityRouter.post('/reports/:id/issues/:issue/resolve', async (req, res) => {
  const id = z.string().uuid().parse(req.params.id)
  const issueId = z
    .string()
    .regex(/^issue-\d+$/)
    .parse(req.params.issue)
  const [report] = await q('SELECT result_json,script_id FROM quality_reports WHERE id=? AND user_id=?', [id, req.user.id])
  ensure(report, 404, 'QUALITY_NOT_FOUND', '报告不存在或无权访问')
  await ownedScript(report.script_id, req.user.id)
  const issue = json(report.result_json)?.issues.find((i) => i.id === issueId)
  ensure(issue, 404, 'ISSUE_NOT_FOUND', '建议不存在')
  const { paragraphId } = z.object({ paragraphId: z.string().max(80).optional() }).parse(req.body || {})
  if (paragraphId) {
    ensure(
      issue.evidence.some((e) => e.paragraphId === paragraphId),
      404,
      'EVIDENCE_NOT_FOUND',
      '该证据不属于此建议'
    )
    await q('INSERT IGNORE INTO quality_evidence_resolutions(report_id,issue_id,paragraph_id,user_id) VALUES(?,?,?,?)', [id, issueId, paragraphId, req.user.id])
  } else await q('INSERT IGNORE INTO quality_issue_resolutions(report_id,issue_id,user_id) VALUES(?,?,?)', [id, issueId, req.user.id])
  res.json({ ok: true })
})
