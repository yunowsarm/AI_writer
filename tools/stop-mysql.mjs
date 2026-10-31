/** 安全停止：校验实例标识后仅关闭本项目 MySQL，不影响系统数据库。 */
import mysql from 'mysql2/promise'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const secrets = JSON.parse(await readFile(new URL('../.local/mysql-root.json', import.meta.url), 'utf8'))
let db
try {
  db = await mysql.createConnection({
    host: '127.0.0.1',
    port: 3308,
    user: 'root',
    password: secrets.password,
    connectTimeout: 3000,
  })
  const [[r]] = await db.query('SELECT @@datadir directory')
  const marker = await readFile(path.join(r.directory, '..', '.instance-id'), 'utf8')
  if (marker !== 'mujian-' + Buffer.from(root).toString('hex'))
    throw new Error('实例标识不匹配，未执行停止操作')
  await db.query('SHUTDOWN')
  console.log('本项目 MySQL 已安全停止，数据已保留。')
} catch (e) {
  if (e.code === 'ECONNREFUSED') console.log('本项目 MySQL 未运行。')
  else {
    console.error(e.message)
    process.exitCode = 1
  }
} finally {
  await db?.end().catch(() => {})
}
