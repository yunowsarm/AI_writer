/** Express 应用组装：安全边界和模块路由集中注册，便于独立集成测试。 */
import express from 'express'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'
import { rateLimit } from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'
import { q } from './db/index.js'
import { errorHandler, AppError } from './shared/errors.js'
import { originGuard } from './shared/origin.js'
import { loadUser } from './modules/auth/service.js'
import { authRouter } from './modules/auth/routes.js'
import { usersRouter } from './modules/users/routes.js'
import { avatarReadRouter } from './modules/users/avatar.js'
import { scriptsRouter, episodesRouter } from './modules/scripts/routes.js'
import { templatesRouter, configsRouter } from './modules/templates/routes.js'
import { communityRouter, favoritesRouter } from './modules/community/routes.js'
import { adminRouter } from './modules/admin/routes.js'
import { aiRouter } from './modules/ai/routes.js'
import { settingsRouter } from './modules/settings/routes.js'
import { usageRouter } from './modules/usage/routes.js'
import { qualityRouter } from './modules/quality/routes.js'

/**
 * 组装可供启动与集成测试复用的 Express 应用。
 * 依次注册安全头、限流、请求校验、会话加载和模块路由；API 404 先于前端页面回退。
 */
export function createApp() {
  const app = express()
  app.disable('x-powered-by')
  app.use(
    helmet({
      contentSecurityPolicy: config.production ? { directives: { 'img-src': ["'self'", 'data:'], 'style-src': ["'self'", "'unsafe-inline'"] } } : false
    })
  )
  app.use((req, res, next) => {
    req.requestId = randomUUID()
    res.setHeader('X-Request-ID', req.requestId)
    next()
  })
  app.use(
    '/api',
    rateLimit({
      windowMs: 60000,
      limit: 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { code: 'RATE_LIMIT', message: '请求过于频繁' }
    })
  )
  app.use(express.json({ limit: '1mb' }))
  app.use(cookieParser())
  // SameSite Cookie + Origin 双重防护。非浏览器集成可省略 Origin。
  app.use('/api', originGuard(config))

  /**
   * GET /api/health
   * 用途：检查服务与 MySQL 连通状态。
   * 权限：无需登录。
   * 入参：无。
   * 返回：ok、数据库类型及 AI 是否已配置；不返回密钥。
   */
  app.get('/api/health', async (req, res) => {
    await q('SELECT 1')
    res.json({ ok: true, database: 'mysql', aiMode: 'per-user' })
  })
  app.use('/api', loadUser)
  app.use('/api/avatars', avatarReadRouter)

  /**
   * POST /api/events/visit
   * 用途：记录一次系统访问事件。
   * 权限：允许匿名；登录时关联当前用户。
   * 入参：无。
   * 返回：ok。
   */
  app.post('/api/events/visit', async (req, res) => {
    await q('INSERT INTO analytics_events(event_type,user_id) VALUES(?,?)', ['visit', req.user?.id || null])
    res.json({ ok: true })
  })
  app.use('/api/auth', authRouter)
  app.use('/api/me', usersRouter)
  app.use('/api/scripts', scriptsRouter)
  app.use('/api/episodes', episodesRouter)
  app.use('/api/templates', templatesRouter)
  app.use('/api/generation-configs', configsRouter)
  app.use('/api/public', communityRouter)
  app.use('/api/favorites', favoritesRouter)
  app.use('/api/admin', adminRouter)
  app.use('/api/me/settings', settingsRouter)
  app.use('/api/me/usage', usageRouter)
  app.use('/api/ai', aiRouter)
  app.use('/api/quality', qualityRouter)
  app.use('/api', (req, res, next) => next(new AppError(404, 'NOT_FOUND', '接口不存在')))
  const dist = fileURLToPath(new URL('../../web/dist', import.meta.url))
  if (existsSync(dist)) {
    app.use(express.static(dist))

    /**
     * GET /{*path}
     * 用途：生产构建存在时，为前端页面路由返回应用入口。
     * 权限：无需登录；业务接口单独鉴权。
     * 入参：路径为前端路由。
     * 返回：web/dist/index.html 文件。
     */
    app.get('/{*path}', (req, res) => res.sendFile(dist + '/index.html'))
  }
  app.use(errorHandler)
  return app
}
