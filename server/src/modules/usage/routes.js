/** 个人 AI 用量：所有汇总、图表、模型列表和明细均强制绑定当前用户。 */
import { Router } from 'express'
import { z } from 'zod'
import { q } from '../../db/index.js'
import { requireUser } from '../auth/service.js'
import { costValue, estimateCost, pricingUpdatedAt } from './pricing.js'
export const usageRouter = Router()
usageRouter.use(requireUser)

/**
 * GET /api/me/usage
 * 用途：汇总本人的 AI 请求用量、每日趋势、模型分布和分页明细。
 * 权限：登录用户，仅本人；不接受客户端传入的用户 ID，不返回提示词、正文或密钥。
 * 入参：Query：days=7/30/90、model、page、size（最多 60）。
 * 返回：summary、daily、models、availableModels、items、total，统计时区为 UTC。
 * 费用仅依据上游实际返回的缓存明细计算官方峰谷美元区间，缺失明细不估算。
 */
usageRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  const filter = z
    .object({
      days: z.coerce
        .number()
        .refine((n) => [7, 30, 90].includes(n))
        .default(7),
      model: z.string().max(100).default(''),
      page: z.coerce.number().int().min(1).default(1),
      size: z.coerce.number().int().min(1).max(60).default(20)
    })
    .parse(req.query)
  // 日期按 UTC 自然日统计；仅将前面校验过的天数插入 SQL，模型条件仍使用占位符。
  const since = `DATE_SUB(UTC_DATE(),INTERVAL ${filter.days - 1} DAY)`,
    where = `r.user_id=? AND r.created_at>=${since} AND (?='' OR r.model=?)`,
    values = [req.user.id, filter.model, filter.model]
  const [raw] = await q(
    `SELECT COUNT(*) requests,COALESCE(SUM(status='completed'),0) completed,COALESCE(SUM(status='failed'),0) failed,COALESCE(SUM(status='cancelled'),0) cancelled,COALESCE(SUM(status='running'),0) running,COALESCE(SUM(prompt_tokens),0) promptTokens,COALESCE(SUM(completion_tokens),0) completionTokens,COALESCE(SUM(total_tokens),0) totalTokens,COUNT(total_tokens) knownUsage,COALESCE(AVG(CASE WHEN status<>'running' THEN elapsed_ms END),0) averageMs FROM ai_requests r WHERE ${where}`,
    values
  )
  const summary = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]))
  // 一个创作任务可能触发大纲与多集调用，任务数和请求数分开统计。
  const [jobs] = await q(
    `SELECT COUNT(*) tasks,COALESCE(SUM(NOT EXISTS(SELECT 1 FROM ai_requests r WHERE r.job_id=j.id)),0) untrackedTasks FROM ai_jobs j WHERE j.user_id=? AND j.created_at>=${since} AND (?='' OR j.model=?)`,
    values
  )
  // 运行中请求不进入成功率分母；没有已结束请求时返回 null，避免显示虚假百分比。
  const ended = summary.requests - summary.running
  Object.assign(summary, {
    tasks: Number(jobs.tasks),
    untrackedTasks: Number(jobs.untrackedTasks),
    // 缺少 Token 的请求单独计数，不把缺失值解释为实际零消耗。
    missingUsage: summary.requests - summary.knownUsage,
    successRate: ended ? Math.round((summary.completed / ended) * 1000) / 10 : null
  })
  const dailyRows = await q(
    `SELECT DATE(r.created_at) day,r.model,r.provider_base_url,COUNT(*) requests,SUM(status='completed') completed,COALESCE(SUM(prompt_tokens),0) promptTokens,COALESCE(SUM(completion_tokens),0) completionTokens,COALESCE(SUM(total_tokens),0) tokens,COUNT(total_tokens) knownUsage,COALESCE(SUM(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN prompt_cache_hit_tokens ELSE 0 END),0) cacheHitTokens,COALESCE(SUM(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN prompt_cache_miss_tokens ELSE 0 END),0) cacheMissTokens,COALESCE(SUM(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN completion_tokens ELSE 0 END),0) pricedCompletionTokens,COUNT(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN 1 END) pricedRequests FROM ai_requests r WHERE ${where} GROUP BY DATE(r.created_at),r.model,r.provider_base_url ORDER BY day`,
    values
  )
  const modelRows = await q(
    `SELECT r.model,r.provider_base_url,MAX(r.provider_name) providerName,COUNT(*) requests,COALESCE(SUM(prompt_tokens),0) promptTokens,COALESCE(SUM(completion_tokens),0) completionTokens,COALESCE(SUM(total_tokens),0) tokens,COUNT(total_tokens) knownUsage,COALESCE(SUM(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN prompt_cache_hit_tokens ELSE 0 END),0) cacheHitTokens,COALESCE(SUM(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN prompt_cache_miss_tokens ELSE 0 END),0) cacheMissTokens,COALESCE(SUM(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN completion_tokens ELSE 0 END),0) pricedCompletionTokens,COUNT(CASE WHEN prompt_cache_hit_tokens IS NOT NULL AND prompt_cache_miss_tokens IS NOT NULL AND completion_tokens IS NOT NULL THEN 1 END) pricedRequests FROM ai_requests r WHERE ${where} GROUP BY r.model,r.provider_base_url ORDER BY requests DESC`,
    values
  )
  // 汇总按模型的 Token 后再计算，费用公式为线性关系，避免暴露不必要的逐条记录。
  const withCost = (row) => {
    const cost = Number(row.pricedRequests) ? estimateCost({ ...row, providerBaseUrl: row.provider_base_url, completionTokens: row.pricedCompletionTokens }) : null
    return {
      ...row,
      requests: Number(row.requests),
      tokens: Number(row.tokens),
      promptTokens: Number(row.promptTokens),
      completionTokens: Number(row.completionTokens),
      knownUsage: Number(row.knownUsage),
      cacheHitTokens: Number(row.cacheHitTokens),
      cacheMissTokens: Number(row.cacheMissTokens),
      pricedRequests: cost ? Number(row.pricedRequests) : 0,
      offPeakUsd: cost ? costValue(cost.offPeakUsd) : null,
      peakUsd: cost ? costValue(cost.peakUsd) : null,
      offPeakCny: cost ? costValue(cost.offPeakCny) : null,
      peakCny: cost ? costValue(cost.peakCny) : null
    }
  }
  const models = modelRows.map(withCost)
  const dailyByDay = new Map()
  for (const row of dailyRows.map(withCost)) {
    const day = String(row.day).slice(0, 10)
    const current = dailyByDay.get(day) || {
      day,
      requests: 0,
      completed: 0,
      promptTokens: 0,
      completionTokens: 0,
      tokens: 0,
      knownUsage: 0,
      pricedRequests: 0,
      offPeakUsd: 0,
      peakUsd: 0,
      offPeakCny: 0,
      peakCny: 0
    }
    current.requests += row.requests
    current.completed += Number(row.completed)
    current.promptTokens += row.promptTokens
    current.completionTokens += row.completionTokens
    current.tokens += row.tokens
    current.knownUsage += row.knownUsage
    current.pricedRequests += row.pricedRequests
    current.offPeakUsd += row.offPeakUsd || 0
    current.peakUsd += row.peakUsd || 0
    current.offPeakCny += row.offPeakCny || 0
    current.peakCny += row.peakCny || 0
    dailyByDay.set(day, current)
  }
  const daily = [...dailyByDay.values()].map((row) => ({
    ...row,
    offPeakUsd: costValue(row.offPeakUsd),
    peakUsd: costValue(row.peakUsd),
    offPeakCny: costValue(row.offPeakCny),
    peakCny: costValue(row.peakCny)
  }))
  const costs = models.reduce(
    (total, row) => ({
      pricedRequests: total.pricedRequests + row.pricedRequests,
      offPeakUsd: total.offPeakUsd + (row.offPeakUsd || 0),
      peakUsd: total.peakUsd + (row.peakUsd || 0),
      offPeakCny: total.offPeakCny + (row.offPeakCny || 0),
      peakCny: total.peakCny + (row.peakCny || 0)
    }),
    { pricedRequests: 0, offPeakUsd: 0, peakUsd: 0, offPeakCny: 0, peakCny: 0 }
  )
  Object.assign(summary, {
    pricedRequests: costs.pricedRequests,
    unpricedRequests: summary.requests - costs.pricedRequests,
    offPeakUsd: costValue(costs.offPeakUsd),
    peakUsd: costValue(costs.peakUsd),
    offPeakCny: costValue(costs.offPeakCny),
    peakCny: costValue(costs.peakCny)
  })
  const availableModels = await q('SELECT DISTINCT model FROM ai_jobs WHERE user_id=? UNION SELECT DISTINCT model FROM ai_requests WHERE user_id=?', [req.user.id, req.user.id])
  const items = await q(
    `SELECT r.id,r.job_id,r.model,r.provider_name,r.provider_base_url,r.phase,r.episode_no,r.status,r.prompt_tokens,r.completion_tokens,r.total_tokens,r.prompt_cache_hit_tokens,r.prompt_cache_miss_tokens,r.elapsed_ms,r.error_code,r.created_at,j.operation,u.nickname FROM ai_requests r JOIN ai_jobs j ON j.id=r.job_id JOIN users u ON u.id=r.user_id WHERE ${where} ORDER BY r.id DESC LIMIT ${filter.size} OFFSET ${(filter.page - 1) * filter.size}`,
    values
  )
  res.json({
    summary,
    daily,
    models,
    availableModels: availableModels.map((m) => m.model),
    items: items.map((item) => {
      const cost = estimateCost({
        model: item.model,
        providerBaseUrl: item.provider_base_url,
        cacheHitTokens: item.prompt_cache_hit_tokens,
        cacheMissTokens: item.prompt_cache_miss_tokens,
        completionTokens: item.completion_tokens
      })
      return {
        ...item,
        offPeakUsd: cost ? costValue(cost.offPeakUsd) : null,
        peakUsd: cost ? costValue(cost.peakUsd) : null,
        offPeakCny: cost ? costValue(cost.offPeakCny) : null,
        peakCny: cost ? costValue(cost.peakCny) : null
      }
    }),
    total: summary.requests,
    days: filter.days,
    page: filter.page,
    timezone: 'UTC',
    pricingUpdatedAt
  })
})
