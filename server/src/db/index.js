/** 数据库边界：参数化查询与事务；业务模块不自行拼接用户输入。 */
import mysql from 'mysql2/promise'
import { config } from '../config.js'
export const pool = mysql.createPool(config.db)
// TIMESTAMP 在数据库会话中统一使用 UTC，展示层再转换为北京时间。
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+00:00'")
})

/**
 * 执行参数化 SQL，返回结果行或写入结果。
 * db 可传入事务连接；省略时使用共享连接池，确保同一事务内的查询显式复用连接。
 */
export async function q(sql, params = [], db = pool) {
  const [rows] = await db.execute(sql, params)
  return rows
}

/**
 * 在独立连接上执行事务回调，成功提交，异常回滚。
 * 无论成功或失败都释放连接；业务异常继续向上传递。
 */
export async function transaction(work) {
  const db = await pool.getConnection()
  try {
    await db.beginTransaction()
    const result = await work(db)
    await db.commit()
    return result
  } catch (e) {
    await db.rollback()
    throw e
  } finally {
    db.release()
  }
}

/**
 * 兼容 MySQL 驱动返回 JSON 字符串或已解析对象的两种情况。
 */
export const json = (value) => (typeof value === 'string' ? JSON.parse(value) : value)
