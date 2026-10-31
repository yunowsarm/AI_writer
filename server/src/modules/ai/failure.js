/** 流式任务异常收尾：先通知浏览器，再尽力持久化；数据库断开不能吞掉错误事件。 */
import { q } from '../../db/index.js'
import { isDatabaseUnavailable } from '../../shared/errors.js'

/** 保留任务和剧本标识供继续生成；输出仍保留在浏览器，不能宣称未提交的分集已保存。 */
export async function finishFailedJob(job, error, { output = '', scriptId, reportId } = {}) {
  const cancelled = job.controller.signal.aborted
  const databaseUnavailable = isDatabaseUnavailable(error)
  const code = cancelled ? 'CANCELLED' : databaseUnavailable ? 'DATABASE_UNAVAILABLE' : error.code || 'AI_FAILED'
  job.send(cancelled ? 'cancelled' : 'error', {
    code,
    scriptId,
    reportId,
    retryable: true,
    message: cancelled
      ? '任务已停止，可继续生成尚未保存的分集'
      : databaseUnavailable
        ? '数据库连接中断，生成已停止。请待数据库恢复后点击“继续生成”；当前未保存的输出可先复制备份。'
        : error.status
          ? error.message
          : '生成失败，请检查已保存的分集后继续生成'
  })
  try {
    await q('UPDATE ai_jobs SET status=?,output=?,error_code=? WHERE id=?', [cancelled ? 'cancelled' : 'failed', output, code, job.id])
  } catch (persistError) {
    // 仅打印安全错误码；恢复后由任务查询或服务重启回收残留 running 状态。
    console.warn('[AI_FINALIZE_DEFERRED]', persistError.code || persistError.name)
  }
}
