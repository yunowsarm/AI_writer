/** 开发启动器：管理自己创建的进程，源码 / .env 变化后以全新环境重启服务。 */
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { access, readFile } from 'node:fs/promises'
import { watch } from 'node:fs'
import dotenv from 'dotenv'
import { startLocalMysql } from './setup.mjs'
import mysql from 'mysql2/promise'
import { superviseMysql } from './mysql-supervisor.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
// 仅解析连接信息；不把 .env 灌入启动器，避免后端继承过期的密钥。
const settings = dotenv.parse(await readFile(new URL('../.env', import.meta.url), 'utf8'))
let managedMysql = false
try {
  if ((process.env.DB_HOST || settings.DB_HOST || '127.0.0.1') === '127.0.0.1' && Number(process.env.DB_PORT || settings.DB_PORT || 3308) === 3308) {
    await access(new URL('../.local/mysql-data/mysql', import.meta.url))
    managedMysql = true
    const db = await startLocalMysql()
    await db.end()
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e
}
const launch = (args, cwd = root) => spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true })
let server = launch(['server/src/index.js']),
  stopping = false,
  restartTimer = null,
  restarting = false
// 默认仅本机访问；显式配置 DEV_HOST 后才开放局域网，供演示手机扫码使用。
const frontend = launch([fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), '--host', process.env.DEV_HOST || settings.DEV_HOST || '127.0.0.1', '--port', '3003'], fileURLToPath(new URL('../web', import.meta.url)))
// 显式结束旧服务后再启动，避免多层监视器继承旧环境。
function restart() {
  clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    if (stopping || restarting) return
    restarting = true
    const previous = server
    if (previous.exitCode !== null || previous.signalCode !== null) {
      server = launch(['server/src/index.js'])
      restarting = false
      return
    }
    previous.once('exit', () => {
      if (!stopping) {
        server = launch(['server/src/index.js'])
        console.log('后端已重新读取配置')
      }
      restarting = false
    })
    previous.kill()
  }, 350)
}
const sourceWatcher = watch(new URL('../server/src', import.meta.url), { recursive: true }, restart)
// 原独立实例意外退出时恢复其映射和进程；外部数据库配置不进入自动启动路径。
const mysqlSupervisor = managedMysql
  ? superviseMysql({
      probe: async () => {
        const db = await mysql.createConnection({
          host: '127.0.0.1',
          port: 3308,
          user: process.env.DB_USER || settings.DB_USER || 'mujian',
          password: process.env.DB_PASSWORD || settings.DB_PASSWORD || '',
          connectTimeout: 1500
        })
        try {
          await db.query('SELECT 1')
        } finally {
          await db.end()
        }
      },
      recover: async () => {
        const db = await startLocalMysql()
        await db.end()
      },
      onRecovered: () => {
        console.log('项目 MySQL 已恢复，已保存内容保留')
        if (server.exitCode !== null || server.signalCode !== null) restart()
      },
      onError: (error) => console.error('项目 MySQL 检查失败：', error.code || error.name)
    })
  : null
const envWatcher = watch(root, (_, filename) => {
  if (filename?.toString() === '.env') restart()
})
function stopOwned(child) {
  if (!child?.pid || child.exitCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else child.kill('SIGTERM')
}
function shutdown() {
  if (stopping) return
  stopping = true
  clearTimeout(restartTimer)
  sourceWatcher.close()
  mysqlSupervisor?.stop()
  envWatcher.close()
  stopOwned(server)
  stopOwned(frontend)
  process.exit()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown)
frontend.on('error', (e) => {
  console.error(e.message)
  shutdown()
})
