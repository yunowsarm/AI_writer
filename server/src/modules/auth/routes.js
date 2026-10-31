/** 认证接口：账号密码、邮箱找回与真实微信网站授权。 */
import { Router } from 'express'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import nodemailer from 'nodemailer'
import bcrypt from 'bcryptjs'
import { q } from '../../db/index.js'
import { config } from '../../config.js'
import { ensure } from '../../shared/errors.js'
import { settingsView } from '../settings/service.js'
import { sessionCookie } from './windowSession.js'
import { emailRouter, emailReady, consumeEmailCode } from './emailCodes.js'
import { demoQrRouter, demoQrEnabled } from './demoQr.js'
import { createSession, publicUser, verifyLogin, hashToken, issueToken, consumeToken, resetPassword, requireUser } from './service.js'
export const authRouter = Router()
const credentials = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(190)
    .transform((email) => email.toLowerCase()),
  password: z.string().min(8).max(128)
})
authRouter.use(
  rateLimit({
    windowMs: 15 * 60000,
    limit: 40,
    skip: (req) => req.path === '/demo-qr/status',
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { code: 'AUTH_RATE_LIMIT', message: '操作太频繁，请稍后重试' }
  })
)

authRouter.use(emailRouter)

authRouter.use(demoQrRouter)

/**
 * POST /api/auth/register
 * 用途：注册账号并创建登录会话。
 * 权限：无需登录，受认证接口限流保护。
 * 入参：Body：email、password（8～128 字符）、nickname、六位注册验证码 code。
 * SMTP 未配置时拒绝注册，不允许降级绕过邮箱验证。
 * 返回：201，脱敏用户资料，同时写入会话 Cookie。
 */
authRouter.post('/register', async (req, res) => {
  ensure(emailReady(), 503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，暂时无法注册，请联系管理员')
  const body = credentials.extend({ nickname: z.string().trim().min(1).max(40), code: z.string().regex(/^\d{6}$/, '请输入六位邮箱验证码') }).parse(req.body)
  const hash = await bcrypt.hash(body.password, 12)
  const u = await consumeEmailCode(body.email, 'register', body.code, async (db) => {
    // 验证码消费和账号创建保持原子性，注册冲突不能丢失有效验证码。
    const created = await q('INSERT INTO users(email,password_hash,nickname,email_verified_at) VALUES(?,?,?,UTC_TIMESTAMP())', [body.email, hash, body.nickname], db)
    return (await q('SELECT * FROM users WHERE id=?', [created.insertId], db))[0]
  })
  await createSession(u.id, res, req.sessionScope)
  res.status(201).json(publicUser(u))
})

/**
 * POST /api/auth/login
 * 用途：校验账号密码并登录。
 * 权限：无需登录，禁用账号不能登录。
 * 入参：Body：email、password。
 * 返回：脱敏用户资料，同时写入会话 Cookie。
 */
authRouter.post('/login', async (req, res) => {
  const body = credentials.parse(req.body)
  const u = await verifyLogin(body.email, body.password)
  await createSession(u.id, res, req.sessionScope)
  res.json(publicUser(u))
})

/**
 * POST /api/auth/logout
 * 用途：删除当前会话并清除 Cookie；重复退出仍可成功。
 * 权限：允许匿名。
 * 入参：从 Cookie 读取会话令牌。
 * 返回：ok。
 */
authRouter.post('/logout', async (req, res) => {
  if (req.sessionToken) await q('DELETE FROM sessions WHERE token_hash=?', [hashToken(req.sessionToken)])
  res.clearCookie(sessionCookie(req.sessionScope), { path: '/api' })
  res.json({ ok: true })
})

/**
 * GET /api/auth/capabilities
 * 用途：查询微信、找回密码和 AI 功能的配置状态。
 * 权限：无需登录。
 * 入参：无。
 * 返回：wechat、passwordReset、aiConfigured、model，不返回凭据。
 */
authRouter.get('/capabilities', async (req, res) => {
  const ai = await settingsView(req.user?.id)
  res.set('Cache-Control', 'no-store').json({
    wechat: !!(config.wechat.id && config.wechat.secret && config.wechat.callback),
    passwordReset: emailReady(),
    emailCode: emailReady(),
    registrationRequiresEmail: true,
    demoQr: demoQrEnabled(),
    aiConfigured: ai.keyConfigured,
    model: ai.model
  })
})

/**
 * POST /api/auth/password/change
 * 用途：验证旧密码后修改密码，撤销旧会话并重新登录。
 * 权限：已登录用户，仅当前账号。
 * 入参：Body：oldPassword、newPassword（8～128 字符）。
 * 返回：ok，同时更新会话 Cookie。
 */
authRouter.post('/password/change', requireUser, async (req, res) => {
  const b = z.object({ oldPassword: z.string().max(128), newPassword: z.string().min(8).max(128) }).parse(req.body)
  ensure(req.user.password_hash && (await bcrypt.compare(b.oldPassword, req.user.password_hash)), 400, 'PASSWORD_INVALID', '当前密码不正确')
  await q('UPDATE users SET password_hash=? WHERE id=?', [await bcrypt.hash(b.newPassword, 12), req.user.id])
  await q('DELETE FROM sessions WHERE user_id=?', [req.user.id])
  await createSession(req.user.id, res, req.sessionScope)
  res.json({ ok: true })
})

/**
 * POST /api/auth/password-reset/request
 * 用途：向已存在且启用的账号发送 15 分钟有效的密码重置链接。
 * 权限：无需登录；必须配置 SMTP。
 * 入参：Body：email。
 * 返回：统一提示消息，不通过成功响应透露邮箱是否注册。
 */
authRouter.post('/password-reset/request', async (req, res) => {
  ensure(emailReady(), 503, 'EMAIL_NOT_CONFIGURED', '邮箱服务尚未配置，请联系管理员')
  const { email } = z.object({ email: z.string().email().max(190) }).parse(req.body)
  const rows = await q('SELECT id FROM users WHERE email=? AND status=?', [email.toLowerCase(), 'active'])
  if (rows.length) {
    const token = await issueToken('password_reset', rows[0].id)
    const link = `${config.origin}/reset-password?token=${token}`
    await nodemailer.createTransport(config.smtp).sendMail({
      from: config.smtp.from,
      to: email,
      subject: '幕间 · 重置密码',
      text: `请在 15 分钟内打开以下链接设置新密码：\n${link}\n如果不是你发起的操作，请忽略此邮件。`
    })
  }
  res.json({ message: '若账号存在，重置链接已发送至邮箱' })
})

/**
 * POST /api/auth/password-reset/confirm
 * 用途：消费一次性重置凭据，更新密码并撤销该账号全部会话。
 * 权限：无需登录，凭有效令牌授权。
 * 入参：Body：token（64 字符）、password（8～128 字符）。
 * 返回：ok；无效或过期令牌返回业务错误。
 */
authRouter.post('/password-reset/confirm', async (req, res) => {
  const b = z.object({ token: z.string().length(64), password: z.string().min(8).max(128) }).parse(req.body)
  await resetPassword(b.token, b.password)
  res.json({ ok: true })
})
/**
 * GET /api/auth/wechat
 * 用途：创建一次性 state 后跳转微信网站扫码授权。
 * 权限：登录模式允许匿名；绑定模式必须登录。
 * 入参：Query：bind=1 表示绑定当前账号。
 * 返回：302，微信授权页面地址。
 */
authRouter.get('/wechat', async (req, res) => {
  ensure(config.wechat.id && config.wechat.secret && config.wechat.callback, 503, 'WECHAT_NOT_CONFIGURED', '微信登录尚未配置')
  const bind = req.query.bind === '1'
  ensure(!bind || req.user, 401, 'UNAUTHENTICATED', '绑定前请登录')
  const state = await issueToken(bind ? 'wechat_bind' : 'wechat_login', bind ? req.user.id : null)
  res.cookie('mujian_oauth_' + state, '1', { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/api/auth/wechat', maxAge: 15 * 60000 })
  if (req.sessionScope) res.cookie('mujian_wechat_' + state, req.sessionScope, { httpOnly: true, sameSite: 'lax', secure: config.production, path: '/api/auth/wechat', maxAge: 15 * 60000 })
  const url = new URL('https://open.weixin.qq.com/connect/qrconnect')
  url.search = new URLSearchParams({
    appid: config.wechat.id,
    redirect_uri: config.wechat.callback,
    response_type: 'code',
    scope: 'snsapi_login',
    state
  })
  res.redirect(url + '#wechat_redirect')
})

/**
 * GET /api/auth/wechat/callback
 * 用途：用授权码换取微信身份，完成账号登录或绑定。
 * 权限：校验一次性 state；绑定时必须使用原发起账号的会话。
 * 入参：Query：code、state，由微信授权后回传。
 * 返回：设置登录 Cookie 并 302 跳回站点首页。
 */
authRouter.get('/wechat/callback', async (req, res) => {
  const { code, state } = z.object({ code: z.string().min(1).max(500), state: z.string().length(64) }).parse(req.query)
  ensure(config.wechat.id && config.wechat.secret && config.wechat.callback, 503, 'WECHAT_NOT_CONFIGURED', '微信登录尚未配置')
  ensure(req.cookies?.['mujian_oauth_' + state] === '1', 400, 'OAUTH_BROWSER_MISMATCH', '请在发起扫码的浏览器中完成微信登录')
  const states = await q('SELECT kind FROM auth_tokens WHERE token_hash=? AND kind IN (?,?) AND expires_at>UTC_TIMESTAMP()', [hashToken(state), 'wechat_login', 'wechat_bind'])
  ensure(states.length, 400, 'TOKEN_EXPIRED', '授权已过期')
  const tokenUrl = new URL('https://api.weixin.qq.com/sns/oauth2/access_token')
  tokenUrl.search = new URLSearchParams({
    appid: config.wechat.id,
    secret: config.wechat.secret,
    code,
    grant_type: 'authorization_code'
  })
  const result = await (await fetch(tokenUrl, { signal: AbortSignal.timeout(15000) })).json()
  ensure(result.access_token && result.openid, 502, 'WECHAT_FAILED', '微信授权失败，请重试')
  const identity = String(result.unionid || result.openid)
  // state 的删除与身份绑定共用事务，回调并发到达时只能成功消费一次。
  const userId = await consumeToken(state, states[0].kind, async (t, db) => {
    const linked = await q('SELECT user_id FROM oauth_accounts WHERE provider=? AND provider_uid=?', ['wechat', identity], db)
    if (t.kind === 'wechat_bind') {
      // 绑定目标由发起授权时的令牌确定，不能由回调参数指定另一账号。
      ensure(req.user?.id === t.user_id, 403, 'BIND_SESSION_REQUIRED', '请使用发起绑定的账号完成授权')
      ensure(!linked.length || linked[0].user_id === t.user_id, 409, 'ALREADY_BOUND', '此微信已绑定其他账号')
      if (!linked.length) await q('INSERT INTO oauth_accounts VALUES(?,?,?)', ['wechat', identity, t.user_id], db)
      return t.user_id
    }
    if (linked.length) return linked[0].user_id
    const u = await q('INSERT INTO users(nickname) VALUES(?)', ['微信创作者'], db)
    await q('INSERT INTO oauth_accounts VALUES(?,?,?)', ['wechat', identity, u.insertId], db)
    return u.insertId
  })
  const users = await q('SELECT status FROM users WHERE id=?', [userId])
  ensure(users[0]?.status === 'active', 403, 'ACCOUNT_DISABLED', '账号已被禁用')
  await createSession(userId, res, req.sessionScope)
  res.clearCookie('mujian_wechat_' + state, { path: '/api/auth/wechat' })
  res.clearCookie('mujian_oauth_' + state, { path: '/api/auth/wechat' })
  res.redirect(config.origin + '/')
})
