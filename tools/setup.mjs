/** 本机初始化：独立 MySQL 数据目录与随机凭据；不改动系统 MySQL 服务。 */
import { mkdir, readFile, writeFile, access, open } from 'node:fs/promises'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mysql from 'mysql2/promise'
const root = fileURLToPath(new URL('../', import.meta.url)),
  local = path.join(root, '.local'),
  data = path.join(local, 'mysql-data')
const exists = async (p) => {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}
const password = () => randomBytes(24).toString('base64url')
// Windows MySQL 8.0 不支持部分 Unicode 数据目录；SUBST 只给本项目目录提供 ASCII 别名。
async function mysqlLocalPath() {
  if (process.platform !== 'win32' || /^[\x00-\x7F]*$/.test(local)) return local
  await mkdir(local, { recursive: true })
  const marker = 'mujian-' + Buffer.from(root).toString('hex')
  await writeFile(path.join(local, '.instance-id'), marker)
  for (const letter of ['M', 'N', 'O', 'P', 'Q', 'R']) {
    const candidate = letter + ':/'
    if (await exists(candidate)) {
      try {
        if ((await readFile(candidate + '.instance-id', 'utf8')) === marker) return candidate
      } catch {}
      continue
    }
    const mapped = spawnSync('subst.exe', [letter + ':', local], { windowsHide: true })
    if (mapped.status === 0) {
      await writeFile(path.join(local, 'mysql-drive.txt'), letter + ':')
      return candidate
    }
  }
  throw new Error('没有可用的 MySQL ASCII 路径别名，请设置非中文目录运行项目')
}
export async function startLocalMysql() {
  const nativeLocal = await mysqlLocalPath()
  const nativeData = path.join(nativeLocal, 'mysql-data')
  const binary = process.env.MYSQLD_PATH || 'C:/Program Files/MySQL/MySQL Server 8.0/bin/mysqld.exe'
  if (!(await exists(binary)))
    throw new Error('未找到 MySQL，请设置 MYSQLD_PATH 或在 .env 配置外部 MySQL 后运行迁移')
  await mkdir(local, { recursive: true })
  const ini = path.join(nativeLocal, 'mysql.ini')
  await writeFile(
    ini,
    `[mysqld]\nbasedir="${path.dirname(path.dirname(binary)).replaceAll('\\', '/')}"\ndatadir="${nativeData.replaceAll('\\', '/')}"\nport=3308\nbind-address=127.0.0.1\nmysqlx=0\ncharacter-set-server=utf8mb4\ncollation-server=utf8mb4_unicode_ci\nlog-error="${path.join(nativeLocal, 'mysql-error.log').replaceAll('\\', '/')}"\n`
  )
  if (!(await exists(path.join(data, 'mysql')))) {
    await mkdir(data, { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn(binary, [`--defaults-file=${ini}`, '--initialize-insecure', '--console'], {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let error = ''
      child.stderr.on('data', (d) => (error += d))
      child.on('error', reject)
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error('MySQL 初始化失败，请查看 .local/mysql-error.log'))
      )
    })
  }
  const rootFile = path.join(local, 'mysql-root.json')
  let secrets
  if (await exists(rootFile)) secrets = JSON.parse(await readFile(rootFile, 'utf8'))
  else {
    secrets = { password: password() }
    await writeFile(rootFile, JSON.stringify(secrets))
  }
  let connection
  const connect = async (pass) =>
    mysql.createConnection({
      host: '127.0.0.1',
      port: 3308,
      user: 'root',
      password: pass,
      connectTimeout: 1000,
    })
  try {
    connection = await connect(secrets.password)
  } catch (e) {
    if (['ECONNREFUSED', 'ETIMEDOUT'].includes(e.code)) {
      const log = await open(path.join(local, 'mysql-console.log'), 'a')
      const child = spawn(binary, [`--defaults-file=${ini}`, '--console'], {
        windowsHide: true,
        detached: true,
        stdio: ['ignore', log.fd, log.fd],
      })
      child.unref()
      await log.close()
      for (let n = 0; n < 50; n++) {
        await new Promise((r) => setTimeout(r, 300))
        try {
          connection = await connect(secrets.password)
          break
        } catch (err) {
          if (err.code === 'ER_ACCESS_DENIED_ERROR') {
            connection = await connect('')
            break
          }
        }
      }
    } else if (e.code === 'ER_ACCESS_DENIED_ERROR') connection = await connect('')
    else throw e
  }
  if (!connection) throw new Error('MySQL 启动失败，请查看 .local/mysql-error.log')
  const [[server]] = await connection.query('SELECT @@datadir directory')
  if (path.resolve(server.directory).toLowerCase() !== path.resolve(nativeData).toLowerCase()) {
    await connection.end()
    throw new Error('端口 3308 被其他 MySQL 占用，未修改该实例')
  }
  await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [secrets.password])
  return connection
}
async function setup() {
  await mkdir(local, { recursive: true })
  const envPath = path.join(root, '.env')
  let env = (await exists(envPath))
    ? await readFile(envPath, 'utf8')
    : await readFile(path.join(root, '.env.example'), 'utf8')
  const set = (name, value) => {
    if (new RegExp(`^${name}=.+$`, 'm').test(env)) return
    env = env.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${value}`)
  }
  set('DB_PASSWORD', password())
  set('ADMIN_PASSWORD', password())
  await writeFile(envPath, env)
  const get = (name) => env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1]
  const connection = await startLocalMysql()
  for (const database of ['mujian', 'mujian_test'])
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    )
  await connection.query("CREATE USER IF NOT EXISTS 'mujian'@'127.0.0.1' IDENTIFIED BY ?", [
    get('DB_PASSWORD'),
  ])
  await connection.query("ALTER USER 'mujian'@'127.0.0.1' IDENTIFIED BY ?", [get('DB_PASSWORD')])
  for (const database of ['mujian', 'mujian_test'])
    await connection.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO 'mujian'@'127.0.0.1'`)
  await connection.end()
  const { migrate, seed } = await import('../server/scripts/migrate.js')
  await migrate()
  await seed()
  const { pool } = await import('../server/src/db/index.js')
  await pool.end()
  await writeFile(
    path.join(local, '首次登录.txt'),
    `本机管理员\n邮箱：${get('ADMIN_EMAIL')}\n密码：${get('ADMIN_PASSWORD')}\n首次登录后请在个人中心修改密码。\n每个用户登录后，在左侧“API 配置”中填写自己的供应商和 API Key。\n`
  )
  console.log('初始化完成。管理员初始凭据保存在 .local/首次登录.txt；请勿提交或分享此文件。')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  setup().catch((e) => {
    console.error(e.message)
    process.exitCode = 1
  })
