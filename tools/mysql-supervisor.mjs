/** 开发期本地数据库守护：串行检查与恢复，只处理本项目已经初始化的独立实例。 */
export function superviseMysql({ probe, recover, onRecovered = () => {}, onError = () => {}, intervalMs = 5000 }) {
  let checking = false,
    stopped = false

  /** 防止定时检查重叠；恢复失败留待下个周期，不并发启动多个数据库进程。 */
  async function check() {
    if (checking || stopped) return
    checking = true
    try {
      try {
        await probe()
      } catch (error) {
        if (!['ECONNREFUSED', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST', 'ECONNRESET'].includes(error.code)) throw error
        if (stopped) return
        await recover()
        if (!stopped) await onRecovered()
      }
    } catch (error) {
      if (!stopped) onError(error)
    } finally {
      checking = false
    }
  }

  const timer = setInterval(check, intervalMs)
  timer.unref()
  return {
    check,
    stop: () => {
      stopped = true
      clearInterval(timer)
    }
  }
}
