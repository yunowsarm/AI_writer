/** 请求用量记录：按一次模型调用记录，仅接受上游返回的实际 Token，不估算。 */
import { q } from '../../db/index.js'
import { streamCompletion } from '../ai/provider.js'

/**
 * 仅接受非负安全整数 Token 数；缺失或无效统计保留为 null。
 */
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/**
 * 为一次上游模型调用记录阶段、状态、耗时和实际返回的 Token。
 * 先登记 running，再调用流式适配层；finally 中统一记录成功、失败或取消。
 * usage 按最新累计快照替换，不叠加重复统计；未收到用量时保存 NULL，不估算为零。
 */
export async function trackedCompletion(job, messages, options) {
  const row = await q('INSERT INTO ai_requests(job_id,user_id,model,phase,episode_no,status,provider_name,provider_base_url) VALUES(?,?,?,?,?,?,?,?)', [
    job.id,
    job.userId,
    job.settings.model,
    options.phase,
    options.episodeNo || null,
    'running',
    job.settings.providerName || '',
    job.settings.baseUrl
  ])
  const started = Date.now()
  let usage = null,
    status = 'completed',
    errorCode = null
  try {
    return await streamCompletion(messages, {
      ...options,
      settings: job.settings,
      onUsage: (value) => {
        usage = {
          prompt: count(value.prompt_tokens),
          completion: count(value.completion_tokens),
          total: count(value.total_tokens),
          cacheHit: count(value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens),
          cacheMiss: count(value.prompt_cache_miss_tokens)
        }
      }
    })
  } catch (e) {
    status = job.controller.signal.aborted ? 'cancelled' : 'failed'
    errorCode = status === 'cancelled' ? 'CANCELLED' : e.code || 'AI_FAILED'
    throw e
  } finally {
    await q(
      'UPDATE ai_requests SET status=?,prompt_tokens=?,completion_tokens=?,total_tokens=?,prompt_cache_hit_tokens=?,prompt_cache_miss_tokens=?,elapsed_ms=?,error_code=?,finished_at=UTC_TIMESTAMP(3) WHERE id=?',
      [
        status,
        usage?.prompt ?? null,
        usage?.completion ?? null,
        usage?.total ?? null,
        usage?.cacheHit ?? null,
        usage?.cacheMiss ?? null,
        Math.min(4294967295, Date.now() - started),
        errorCode,
        row.insertId
      ]
    )
  }
}
