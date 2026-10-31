/** 应用配置：集中读取环境变量；敏感项始终留在服务端。 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true })
export const config = {
  port: Number(process.env.PORT || 31001),
  host: process.env.HOST || '127.0.0.1',
  origin: process.env.APP_ORIGIN || 'http://127.0.0.1:3003',
  production: process.env.NODE_ENV === 'production',
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3308),
    database: process.env.DB_NAME || 'mujian',
    user: process.env.DB_USER || 'mujian',
    password: process.env.DB_PASSWORD || '',
    charset: 'utf8mb4',
    timezone: 'Z',
    dateStrings: true,
    connectionLimit: 10,
  },
  ai: {
    // 这里只提供默认服务参数；每个用户的 Key 由个人配置服务读取，禁止公共密钥回退。
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    timeout: Number(process.env.AI_TIMEOUT_MS || 180000),
  },
  wechat: {
    id: process.env.WECHAT_APP_ID || '',
    secret: process.env.WECHAT_APP_SECRET || '',
    callback: process.env.WECHAT_CALLBACK || '',
  },
  smtp: {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    from: process.env.SMTP_FROM,
  },
}
