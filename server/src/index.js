/** 服务入口：启动时确认 MySQL 可达，并回收上次异常退出遗留的运行中任务。 */
import { createApp } from './app.js'
import { config } from './config.js'
import { pool, q } from './db/index.js'
import { cancelAll } from './modules/ai/routes.js'
import { loadAiSettings } from './modules/settings/service.js'
await loadAiSettings()
await q('SELECT 1')
await q("UPDATE ai_jobs SET status='failed',error_code='SERVER_RESTARTED' WHERE status='running'")
await q("UPDATE quality_reports SET status='failed',error_code='SERVER_RESTARTED' WHERE status='running'")
await q("UPDATE ai_requests SET status='failed',error_code='SERVER_RESTARTED',finished_at=UTC_TIMESTAMP(3) WHERE status='running'")
const server = createApp().listen(config.port, config.host)
server.once('listening', () => console.log(`幕间服务 http://${config.host}:${config.port}`))
// 端口被其他实例占用时明确失败，避免误报“启动成功”却继续命中旧服务。
server.on('error', async (error) => {
  console.error('后端启动失败：', error.code || error.name)
  await pool.end()
  process.exit(1)
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    cancelAll()
    server.close(async () => {
      await pool.end()
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 5000).unref()
  })
