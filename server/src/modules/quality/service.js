/** 评估编排：冻结快照、分块评审、受限重试、全剧一致性分析和报告持久化。 */
import { randomUUID, createHash } from 'node:crypto'
import { q, json, transaction } from '../../db/index.js'
import { ownedScript } from '../scripts/service.js'
import { trackedCompletion } from '../usage/service.js'
import { ensure } from '../../shared/errors.js'
import { algorithmVersion, fingerprint, parseScript, ruleAnalysis, analysisSchema, consistencySchema, verifyIssues, buildReport } from './algorithm.js'
import { analysisPrompt, consistencyPrompt } from './prompts.js'

/** 事务内读取资料与正文，报告始终绑定同一份保存快照。 */
export async function qualitySnapshot(scriptId, userId) {
  return transaction(async (db) => {
    const script = await ownedScript(scriptId, userId, db)
    const episodes = await q('SELECT id,episode_no,title,content_text,revision FROM episodes WHERE script_id=? ORDER BY episode_no', [scriptId], db)
    return { title: script.title, genre: script.genre, synopsis: script.synopsis, outline: script.outline, config: json(script.config_json), episodes }
  })
}

/** 不静默截断正文；超过评估容量时提示拆分，避免给未分析的内容评分。 */
export function makeChunks(episodes) {
  const chunks = []
  for (const episode of episodes) {
    let paragraphs = [],
      length = 0
    const parts = []
    for (const paragraph of episode.paragraphs) {
      if (length + paragraph.text.length > 7000 && paragraphs.length) {
        parts.push(paragraphs)
        paragraphs = []
        length = 0
      }
      paragraphs.push(paragraph)
      length += paragraph.text.length
    }
    if (paragraphs.length) parts.push(paragraphs)
    parts.forEach((part, index) =>
      chunks.push({ episodeId: episode.id, episodeNo: episode.episode_no, part: index + 1, parts: parts.length, paragraphs: part, characters: part.reduce((sum, p) => sum + p.text.length, 0) })
    )
  }
  ensure(chunks.length > 0, 400, 'EMPTY_SCRIPT', '请先添加剧本正文')
  ensure(chunks.length <= 160, 400, 'QUALITY_TOO_LARGE', '当前剧本超过单次评估容量，请拆分后评估（最多约 100 万字）')
  return chunks
}

/** 只对结构化结果格式错误重试一次；真实网络、鉴权或取消错误直接交给任务处理。 */
export async function analyzeJson(job, messages, schema, phase, episodeNo) {
  for (let attempt = 0; attempt < 2; attempt++) {
    job.controller.signal.throwIfAborted()
    const text = await trackedCompletion(job, messages, { phase, episodeNo, temperature: 0, signal: job.controller.signal })
    try {
      return schema.parse(
        JSON.parse(
          text
            .trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/, '')
        )
      )
    } catch {
      if (attempt === 1) ensure(false, 502, 'QUALITY_JSON_INVALID', '模型未返回有效的结构化评审结果')
      messages = [...messages, { role: 'user', content: '上次响应未通过 JSON 字段或范围校验。请严格按给定结构重新分析；只返回 JSON 对象，所有分数和置信度用数值。' }]
    }
  }
}

/** 块缓存绑定完整评审输入和供应商身份；改了上文、模型或量表时必须重新分析。 */
function analysisKey(messages) {
  return createHash('sha256')
    .update(algorithmVersion + JSON.stringify(messages))
    .digest('hex')
}

/** 按小字段排序取 ID，再读取报告 JSON，避免 MySQL 对大字段排序耗尽 sort buffer。 */
async function previousAnalyses(job, scriptId) {
  const ids = await q(
    "SELECT r.id FROM quality_reports r JOIN ai_jobs j ON j.id=r.job_id WHERE r.user_id=? AND r.script_id=? AND r.algorithm_version=? AND r.status='completed' AND r.model=? AND r.provider_name=? AND JSON_UNQUOTE(JSON_EXTRACT(j.params,'$.selection.providerId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(j.params,'$.providerBaseUrl'))=? AND JSON_UNQUOTE(JSON_EXTRACT(j.params,'$.apiFormat'))=? ORDER BY r.created_at DESC LIMIT 8",
    [job.userId, scriptId, algorithmVersion, job.settings.model, job.settings.providerName || '', String(job.settings.providerId || ''), job.settings.baseUrl, job.settings.apiFormat || 'openai-chat']
  )
  const cache = new Map()
  for (const { id } of ids) {
    const [row] = await q('SELECT result_json FROM quality_reports WHERE id=?', [id])
    for (const analysis of json(row.result_json)?.analyses || []) if (analysis.cacheKey && !cache.has(analysis.cacheKey)) cache.set(analysis.cacheKey, analysis.result)
  }
  return cache
}

/** 在相同内容、算法版本及模型上复用完整报告；部分完成的报告允许重新评估。 */
export async function cachedReport(userId, scriptId, snapshot, settings) {
  const [row] = await q(
    "SELECT r.id FROM quality_reports r JOIN ai_jobs j ON j.id=r.job_id WHERE r.user_id=? AND r.script_id=? AND r.fingerprint=? AND r.model=? AND r.provider_name=? AND r.status='completed' AND JSON_UNQUOTE(JSON_EXTRACT(j.params,'$.selection.providerId'))=? AND JSON_UNQUOTE(JSON_EXTRACT(j.params,'$.providerBaseUrl'))=? AND JSON_UNQUOTE(JSON_EXTRACT(j.params,'$.apiFormat'))=? ORDER BY r.created_at DESC LIMIT 1",
    [userId, scriptId, fingerprint(snapshot), settings.model, settings.providerName || '', String(settings.providerId || ''), settings.baseUrl, settings.apiFormat || 'openai-chat']
  )
  return row?.id
}

/** 执行完整评估；每次模型调用经过统一用量记录，局部失败保留有效结果但不生成总分。 */
export async function evaluate(job, scriptId, snapshot, chunks) {
  const id = randomUUID()
  const episodes = parseScript(snapshot)
  const rules = ruleAnalysis(snapshot, episodes)
  const analyses = [],
    errors = []
  const cache = await previousAnalyses(job, scriptId)
  let reusedChunks = 0
  for (const episode of episodes) if (!episode.paragraphs.length) errors.push({ episodeNo: episode.episode_no, code: 'EMPTY_EPISODE', message: '该集暂无正文，语义分析未完成' })
  let issues = [],
    consistencyComplete = false
  await q('INSERT INTO quality_reports(id,user_id,script_id,job_id,fingerprint,algorithm_version,model,provider_name,status,snapshot_json) VALUES(?,?,?,?,?,?,?,?,?,?)', [
    id,
    job.userId,
    scriptId,
    job.id,
    fingerprint(snapshot),
    algorithmVersion,
    job.settings.model,
    job.settings.providerName || '',
    'running',
    JSON.stringify(snapshot)
  ])
  job.send('report', { reportId: id })
  try {
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      job.controller.signal.throwIfAborted()
      job.send('phase', { message: `正在评估第 ${chunk.episodeNo} 集 · 第 ${chunk.part}/${chunk.parts} 段`, completed: index, total: chunks.length + 1 })
      try {
        const previous = analyses.slice(-3).map((a) => ({ episodeNo: a.episodeNo, summary: a.result.summary, facts: a.result.facts }))
        const messages = analysisPrompt(snapshot, chunk, previous)
        const cacheKey = analysisKey(messages)
        const cached = cache.get(cacheKey)
        const result = cached ? structuredClone(cached) : await analyzeJson(job, messages, analysisSchema, 'evaluation', chunk.episodeNo)
        if (cached) reusedChunks++
        // 清理模型编造的事实引用，再进入全剧状态链，不能用虚构事实推导矛盾。
        const paragraphs = new Map(chunk.paragraphs.map((p) => [p.id, p.text]))
        result.facts = result.facts.filter((fact) => paragraphs.get(fact.evidence.paragraphId)?.includes(fact.evidence.quote))
        issues.push(...verifyIssues(result.issues, [{ paragraphs: chunk.paragraphs }]))
        analyses.push({ ...chunk, cacheKey, result })
      } catch (e) {
        if (job.controller.signal.aborted || ['AI_AUTH_FAILED', 'AI_RATE_LIMIT', 'AI_URL_PRIVATE'].includes(e.code)) throw e
        errors.push({ episodeNo: chunk.episodeNo, part: chunk.part, code: e.code || 'QUALITY_FAILED', message: e.status ? e.message : '该段分析失败' })
      }
    }
    if (analyses.length) {
      job.send('phase', { message: '正在核对全剧人物与事件时间线', completed: chunks.length, total: chunks.length + 1 })
      try {
        const prompt = consistencyPrompt(snapshot, analyses)
        ensure(prompt[1].content.length <= 180000, 400, 'QUALITY_CONTEXT_LIMIT', '全剧事实摘要过长，一致性检查未完成')
        const result = await analyzeJson(job, prompt, consistencySchema, 'consistency')
        issues.push(...verifyIssues(result.issues, episodes, 'consistency'))
        consistencyComplete = true
      } catch (e) {
        if (job.controller.signal.aborted) throw e
        errors.push({ code: e.code || 'QUALITY_FAILED', message: e.status ? e.message : '全剧一致性检查失败' })
      }
    }
    issues = verifyIssues([...rules, ...issues], episodes)
    const result = buildReport(episodes, analyses, issues, consistencyComplete, errors)
    result.evaluator = createHash('sha256')
      .update(JSON.stringify([job.settings.providerId || '', job.settings.baseUrl, job.settings.apiFormat || 'openai-chat', job.settings.model]))
      .digest('hex')
    result.analyses = analyses.map(({ cacheKey, episodeId, episodeNo, part, characters, result }) => ({ cacheKey, episodeId, episodeNo, part, characters, result }))
    result.coverage.reusedChunks = reusedChunks
    await q('UPDATE quality_reports SET status=?,result_json=? WHERE id=?', [result.status, JSON.stringify(result), id])
    await q("UPDATE ai_jobs SET status='completed',output=? WHERE id=?", [JSON.stringify({ reportId: id, status: result.status }), job.id])
    job.send('done', { reportId: id, status: result.status })
  } catch (e) {
    const cancelled = job.controller.signal.aborted
    const status = cancelled ? 'cancelled' : 'failed'
    const result = buildReport(episodes, analyses, verifyIssues([...rules, ...issues], episodes), false, [
      ...errors,
      { code: e.code || 'QUALITY_FAILED', message: cancelled ? '评估已停止' : e.status ? e.message : '评估失败' }
    ])
    await q('UPDATE quality_reports SET status=?,result_json=?,error_code=? WHERE id=?', [status, JSON.stringify(result), cancelled ? 'CANCELLED' : e.code || 'QUALITY_FAILED', id])
    await q('UPDATE ai_jobs SET status=?,error_code=? WHERE id=?', [status, cancelled ? 'CANCELLED' : e.code || 'QUALITY_FAILED', job.id])
    job.send(cancelled ? 'cancelled' : 'error', { reportId: id, message: cancelled ? '评估已停止，已完成的结果已保存' : e.status ? e.message : '评估失败，已保留部分结果' })
  }
}
