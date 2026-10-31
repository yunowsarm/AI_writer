/** 一键优化：后台生成可预览候选，确认后在一个事务中应用，避免部分覆盖与并发丢失。 */
import { q, json, transaction } from '../../db/index.js'
import { ensure } from '../../shared/errors.js'
import { ownedScript, addVersion } from '../scripts/service.js'
import { trackedCompletion } from '../usage/service.js'
import { buildOptimizationPlan } from './optimizationPlan.js'
import { optimizeDocument, episodeBlocks } from './optimizationDocument.js'
import { analyzeJson } from './service.js'
import { reviewVersion, candidateGuard, reviewBatches, estimatedReviewCalls, comparisonPrompt, comparisonSchema, reviewDecision, optimizationPrompt } from './optimizationReview.js'

/** 只读取本人报告及当前正文；旧报告中仍未改动的证据可以继续使用。 */
export async function optimizationInput(reportId, userId) {
  const [row] = await q('SELECT * FROM quality_reports WHERE id=? AND user_id=?', [reportId, userId])
  ensure(row, 404, 'QUALITY_NOT_FOUND', '报告不存在或无权访问')
  ensure(row.status !== 'running', 409, 'QUALITY_RUNNING', '请等待当前评估完成')
  const script = await ownedScript(row.script_id, userId)
  const episodes = await q('SELECT * FROM episodes WHERE script_id=? ORDER BY episode_no', [row.script_id])
  const resolved = await q('SELECT issue_id FROM quality_issue_resolutions WHERE report_id=? AND user_id=?', [reportId, userId])
  const evidence = await q('SELECT issue_id issueId,paragraph_id paragraphId FROM quality_evidence_resolutions WHERE report_id=? AND user_id=? ORDER BY issue_id,paragraph_id', [reportId, userId])
  const report = { ...row, snapshot: json(row.snapshot_json), result: json(row.result_json) }
  const ignored = await q('SELECT issue_id FROM quality_issue_ignores WHERE report_id=? AND user_id=?', [reportId, userId])
  const plan = buildOptimizationPlan(report, episodes, [...new Set([...resolved, ...ignored].map((r) => r.issue_id))].sort(), evidence)
  return { script, report, episodes, plan }
}

/** 完成若干候选后重新组装分集预览，不触碰实际正文。 */
function previews(episodes, changes) {
  return episodes.flatMap((e) => {
    const done = changes.filter((c) => c.episodeId === e.id && ['completed', 'review'].includes(c.status))
    if (!done.length) return []
    const draft = optimizeDocument(e, done)
    return [{ id: e.id, episodeNo: e.episode_no, title: e.title, revision: e.revision, before: e.content_text, after: draft.text }]
  })
}

/** 逐段生成后交换 A/B 顺序复核，只有稳定改善的候选默认推荐；停止后保留已完成结果。 */
export async function runOptimization(job, input) {
  const { plan, episodes, report, script } = input
  const result = { reportId: report.id, scriptId: script.id, title: script.title, reviewVersion, changes: plan.changes, skipped: plan.skipped, episodes: [], status: 'running', applied: null }
  const persist = async (status) => {
    result.status = status
    result.episodes = previews(episodes, result.changes)
    await q('UPDATE ai_jobs SET output=? WHERE id=?', [JSON.stringify(result), job.id])
  }
  let completed = 0
  let total = plan.total + estimatedReviewCalls(plan.changes)
  job.send('phase', { reportId: report.id, message: '正在按评估建议优化', completed, total })
  try {
    for (const change of result.changes) {
      job.controller.signal.throwIfAborted()
      job.send('phase', { message: `正在生成第 ${change.episodeNo} 集 · ${completed + 1}/${plan.total} 处候选`, completed, total })
      try {
        if (change.kind !== 'delete') {
          const episode = episodes.find((e) => e.id === change.episodeId)
          const output = await trackedCompletion(job, optimizationPrompt({ ...script, config: json(script.config_json) }, episode, change), {
            phase: 'rewrite',
            episodeNo: change.episodeNo,
            temperature: 0.2,
            signal: job.controller.signal
          })
          change.after = output
            .trim()
            .replace(/^```(?:markdown|text)?\s*\n?/i, '')
            .replace(/\n?```$/, '')
            .trim()
          ensure(change.after, 502, 'EMPTY_OPTIMIZATION', '模型返回空候选，该处未处理')
        }
        change.status = change.after === change.before ? 'unchanged' : change.kind === 'delete' ? 'completed' : 'reviewing'
        if (change.status === 'reviewing') {
          const guard = candidateGuard(change)
          change.warnings = guard.warnings
          if (guard.problems.length) {
            change.status = 'rejected'
            change.review = { reason: guard.problems.join('；'), method: 'structure' }
          }
        }
      } catch (e) {
        change.status = 'failed'
        change.error = e.status ? e.message : '该处优化失败'
        if (job.controller.signal.aborted || ['AI_AUTH_FAILED', 'AI_RATE_LIMIT', 'AI_CONNECTION_FAILED'].includes(e.code)) throw e
      }
      completed++
      await persist('running')
      job.send('phase', { message: `已生成 ${completed}/${plan.total} 处，接下来复核改善情况`, completed, total })
    }
    // 多处改写不得生成同一句模板台词；对新引入的完全重复保留原稿。
    for (const episode of episodes) {
      const seen = new Map()
      const rewrites = result.changes.filter((c) => c.episodeId === episode.id && c.status === 'reviewing')
      const targeted = new Set(rewrites.map((c) => c.blockIndex))
      for (const block of episodeBlocks(episode)) if (!targeted.has(block.index)) seen.set(block.text.trim(), block.text)
      for (const change of rewrites) {
        if (seen.has(change.after.trim()) && seen.get(change.after.trim()) !== change.before) {
          change.status = 'rejected'
          change.review = { reason: '候选引入了新的完全重复段落，已保留原稿', method: 'repetition' }
        } else seen.set(change.after.trim(), change.before)
      }
    }
    const batches = reviewBatches(result.changes.filter((c) => c.status === 'reviewing'))
    total = completed + batches.length * 2 + new Set(batches.flat().map((c) => c.episodeId)).size * 2
    for (const batch of batches) {
      job.controller.signal.throwIfAborted()
      const episode = episodes.find((e) => e.id === batch[0].episodeId)
      const reviews = []
      try {
        for (const reverse of [false, true]) {
          job.send('phase', { message: `正在复核第 ${episode.episode_no} 集 · ${reverse ? '交换顺序复核' : '首次匿名比较'}`, completed, total })
          const review = await analyzeJson(job, comparisonPrompt({ ...script, config: json(script.config_json) }, episode, batch, reverse), comparisonSchema, 'verification', episode.episode_no)
          ensure(
            review.comparisons.length === batch.length &&
              new Set(review.comparisons.map((r) => r.changeId)).size === batch.length &&
              review.comparisons.every((r) => batch.some((c) => c.id === r.changeId)),
            502,
            'OPTIMIZATION_REVIEW_INVALID',
            '复核未完整覆盖本批候选'
          )
          reviews.push(review.comparisons)
          completed++
        }
        for (const change of batch) {
          const passes = reviews.map((r) => r.find((entry) => entry.changeId === change.id))
          const decision = reviewDecision(change, ...passes)
          change.status = decision.status
          change.review = { reason: decision.reason, method: reviewVersion, summary: decision.summary, passes }
        }
      } catch (e) {
        for (const change of batch) {
          change.status = 'review'
          change.review = { method: reviewVersion, reason: '复核未完成，默认保留原稿；请检查差异后单独勾选确认', code: e.code || 'REVIEW_FAILED' }
        }
        if (job.controller.signal.aborted || ['AI_AUTH_FAILED', 'AI_RATE_LIMIT', 'AI_CONNECTION_FAILED'].includes(e.code)) throw e
      }
      await persist('running')
    }
    for (const episode of episodes) {
      const selected = result.changes.filter((c) => c.episodeId === episode.id && c.status === 'completed')
      if (!selected.some((c) => c.kind === 'rewrite')) continue
      const draft = optimizeDocument(episode, selected)
      const combined = {
        id: `episode-${episode.id}`,
        kind: 'episode-review',
        episodeId: episode.id,
        blockIndex: 0,
        before: episode.content_text,
        after: draft.text,
        issues: selected.flatMap((c) => c.issues)
      }
      let decision
      try {
        // 无法完整放入复核上下文时保留人工预览，不静默截断后给出“通过”。
        ensure(combined.before.length + combined.after.length <= 100000, 400, 'REVIEW_CONTEXT_LIMIT', '整集较长，无法完整复核，请人工确认衔接')
        const passes = []
        for (const reverse of [false, true]) {
          job.send('phase', { message: `正在检查第 ${episode.episode_no} 集整体衔接 · ${reverse ? '交换顺序复核' : '首次比较'}`, completed, total })
          const value = await analyzeJson(job, comparisonPrompt({ ...script, config: json(script.config_json) }, episode, [combined], reverse), comparisonSchema, 'verification', episode.episode_no)
          ensure(value.comparisons.length === 1 && value.comparisons[0].changeId === combined.id, 502, 'OPTIMIZATION_REVIEW_INVALID', '整集复核结果不完整')
          passes.push(value.comparisons[0])
          completed++
        }
        decision = reviewDecision(combined, ...passes)
        result.episodeReviews ||= []
        result.episodeReviews.push({ episodeId: episode.id, ...decision, passes })
      } catch (e) {
        decision = { status: 'review', reason: e.code === 'REVIEW_CONTEXT_LIMIT' ? e.message : '整集衔接复核未完成，请人工确认' }
        if (job.controller.signal.aborted || ['AI_AUTH_FAILED', 'AI_RATE_LIMIT', 'AI_CONNECTION_FAILED'].includes(e.code)) {
          for (const change of selected) {
            change.status = 'review'
            change.review = { ...change.review, reason: decision.reason }
          }
          throw e
        }
      }
      if (decision.status !== 'completed')
        for (const change of selected) {
          change.status = decision.status
          change.review = { ...change.review, reason: '整集复核：' + decision.reason }
        }
      await persist('running')
    }
    const partial = result.changes.some((c) => c.status !== 'completed') || result.skipped.length > 0
    await persist(partial ? 'partial' : 'completed')
    await q("UPDATE ai_jobs SET status='completed' WHERE id=?", [job.id])
    job.send('done', { scriptId: script.id, reportId: report.id, status: result.status, message: '优化及复核已完成，请预览推荐与待确认的候选' })
  } catch (e) {
    const cancelled = job.controller.signal.aborted
    for (const change of result.changes.filter((c) => c.status === 'reviewing')) {
      change.status = 'review'
      change.review = { method: reviewVersion, reason: '任务在复核前结束，默认保留原稿；请人工确认' }
    }
    await persist(cancelled ? 'cancelled' : 'failed')
    await q('UPDATE ai_jobs SET status=?,error_code=? WHERE id=?', [cancelled ? 'cancelled' : 'failed', cancelled ? 'CANCELLED' : e.code || 'OPTIMIZATION_FAILED', job.id])
    job.send(cancelled ? 'cancelled' : 'error', {
      scriptId: script.id,
      reportId: report.id,
      message: cancelled ? '优化已停止，已完成候选仍可预览' : '部分优化未完成，可预览已生成的候选',
      code: cancelled ? 'CANCELLED' : e.code || 'OPTIMIZATION_FAILED'
    })
  }
}

/** 确认应用时锁定任务与所有受影响分集，校验 revision 后统一提交；重复点击不会重复生成版本。 */
export async function applyOptimization(jobId, userId, changeIds, acknowledgedReviewIds = []) {
  return transaction(async (db) => {
    const [job] = await q("SELECT * FROM ai_jobs WHERE id=? AND user_id=? AND operation='optimize' FOR UPDATE", [jobId, userId], db)
    ensure(job, 404, 'OPTIMIZATION_NOT_FOUND', '优化任务不存在或无权访问')
    ensure(job.status !== 'running', 409, 'OPTIMIZATION_RUNNING', '请等待优化结束或停止任务后再应用')
    const result = json(job.output)
    ensure(result?.changes, 409, 'OPTIMIZATION_EMPTY', '暂无可应用的优化结果')
    if (result.applied) return { ...result.applied, alreadyApplied: true }
    await ownedScript(result.scriptId, userId, db)
    const ignored = await q('SELECT issue_id FROM quality_issue_ignores WHERE report_id=? AND user_id=?', [result.reportId, userId], db)
    const requested = new Set(changeIds)
    const changes = result.changes.filter((c) => requested.has(c.id) && ['completed', 'review'].includes(c.status))
    ensure(
      !changes.some((c) => c.evidence?.some((e) => ignored.some((i) => i.issue_id === e.issueId))),
      409,
      'OPTIMIZATION_ISSUE_IGNORED',
      '部分候选对应的问题已被忽略，请重新生成优化计划或恢复该问题'
    )
    ensure(changes.length && changes.length === requested.size, 400, 'OPTIMIZATION_SELECTION_INVALID', '请选择有效的优化候选')
    ensure(result.reviewVersion === reviewVersion || changes.every((c) => c.kind === 'delete'), 409, 'OPTIMIZATION_REVIEW_REQUIRED', '旧版候选未经过改善复核，请重新生成一键优化候选')
    ensure(
      changes.filter((c) => c.status === 'review').every((c) => acknowledgedReviewIds.includes(c.id)),
      400,
      'OPTIMIZATION_REVIEW_CONFIRM',
      '待确认候选需要逐项勾选并确认风险后才能应用'
    )
    const current = await q('SELECT * FROM episodes WHERE script_id=? ORDER BY id FOR UPDATE', [result.scriptId], db)
    const affected = current.filter((e) => changes.some((c) => c.episodeId === e.id))
    ensure(affected.length === new Set(changes.map((c) => c.episodeId)).size, 409, 'EPISODE_NOT_FOUND', '目标分集已被删除，请重新优化')
    for (const e of affected) {
      const source = result.episodes.find((p) => p.id === e.id)
      ensure(source?.revision === e.revision && source.before === e.content_text, 409, 'REVISION_CONFLICT', '正文已更新，本次候选未应用；请先重新优化，避免覆盖修改')
    }
    for (const e of affected) {
      const selected = changes.filter((c) => c.episodeId === e.id)
      const content = optimizeDocument(e, selected)
      await addVersion(e, '一键优化前备份', db)
      await q(
        'UPDATE episodes SET document_json=?,content_html=?,content_text=?,revision=revision+1 WHERE id=? AND revision=?',
        [content.document ? JSON.stringify(content.document) : null, content.html, content.text, e.id, e.revision],
        db
      )
      await addVersion({ ...e, document_json: content.document, content_html: content.html, content_text: content.text, revision: e.revision + 1 }, '应用质量评估一键优化', db)
    }
    for (const change of changes) {
      // 作者采用待确认候选仅表示已修改，不能冒充算法确认问题已解决；仍留待重新评估。
      if (change.status !== 'completed') continue
      for (const evidence of change.evidence)
        await q('INSERT IGNORE INTO quality_evidence_resolutions(report_id,issue_id,paragraph_id,user_id) VALUES(?,?,?,?)', [result.reportId, evidence.issueId, evidence.paragraphId, userId], db)
      for (const issueId of change.wholeIssues) await q('INSERT IGNORE INTO quality_issue_resolutions(report_id,issue_id,user_id) VALUES(?,?,?)', [result.reportId, issueId, userId], db)
    }
    await q('UPDATE scripts SET updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [result.scriptId], db)
    result.applied = { changeIds: [...requested], episodeIds: affected.map((e) => e.id), at: new Date().toISOString() }
    await q('UPDATE ai_jobs SET output=? WHERE id=?', [JSON.stringify(result), jobId], db)
    return result.applied
  })
}
