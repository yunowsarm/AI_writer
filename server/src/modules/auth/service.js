/** 账号服务：密码哈希、服务端会话、账号状态和一次性凭据。 */
import bcrypt from 'bcryptjs'
import { randomBytes, createHash } from 'node:crypto'
import { q, transaction } from '../../db/index.js'
import { config } from '../../config.js'
import { ensure } from '../../shared/errors.js'
import { sessionScope, sessionCookie } from './windowSession.js'

/**
 * 将会话或一次性令牌转换为 SHA-256 摘要，数据库不存令牌原文。
 */
export const hashToken = (t) => createHash('sha256').update(t).digest('hex')

/**
 * 投影可返回浏览器的用户资料，排除密码哈希等内部字段。
 */
export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  emailVerified: !!u.email_verified_at,
  emailVerifiedAt: u.email_verified_at || null,
  avatarUrl: u.avatar_version ? `/api/avatars/${u.id}?v=${u.avatar_version}` : null,
  nickname: u.nickname,
  bio: u.bio,
  role: u.role,
  createdAt: u.created_at
})

/**
 * 生成随机令牌，将摘要与七天有效期写入会话表。
 * 原文仅写入对应窗口的 HttpOnly Cookie；生产环境启用 Secure，路径限定为 /api。
 */
export async function createSession(userId, res, scope = '') {
  const token = randomBytes(32).toString('hex')
  await q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 7 DAY))', [hashToken(token), userId])
  res.cookie(sessionCookie(scope), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    maxAge: 7 * 86400000,
    path: '/api'
  })
  return token
}

/**
 * 会话加载中间件：从当前窗口对应的 Cookie 摘要查询未过期且启用的用户。
 * 未登录时继续请求，由具体路由决定是否强制登录；查询异常交给统一错误处理器。
 */
export async function loadUser(req, res, next) {
  try {
    req.sessionScope = sessionScope(req)
    const token = req.cookies?.[sessionCookie(req.sessionScope)]
    req.sessionToken = token
    if (token) {
      const rows = await q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() AND u.status=?', [hashToken(token), 'active'])
      req.user = rows[0] || null
    }
    next()
  } catch (e) {
    next(e)
  }
}

/**
 * 登录鉴权中间件：没有有效 req.user 时返回 401。
 */
export const requireUser = (req, res, next) => {
  try {
    ensure(req.user, 401, 'UNAUTHENTICATED', '请先登录')
    next()
  } catch (e) {
    next(e)
  }
}

/**
 * 管理员鉴权中间件：仅允许 role 为 admin 的当前用户继续请求。
 */
export const requireAdmin = (req, res, next) => {
  try {
    ensure(req.user?.role === 'admin', 403, 'FORBIDDEN', '需要管理员权限')
    next()
  } catch (e) {
    next(e)
  }
}

/**
 * 校验邮箱、密码及账号状态。
 * 不存在或没有密码的账号也执行一次 bcrypt 比对，并使用统一登录失败提示。
 */
export async function verifyLogin(email, password) {
  const users = await q('SELECT * FROM users WHERE email=?', [email.toLowerCase()])
  const u = users[0]
  const dummy = '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW'
  const valid = await bcrypt.compare(password, u?.password_hash || dummy)
  ensure(valid && u, 401, 'LOGIN_FAILED', '账号或密码错误')
  ensure(u.status === 'active', 403, 'ACCOUNT_DISABLED', '账号已被禁用')
  return u
}

/**
 * 创建十五分钟有效的一次性凭据，按 kind 区分重置密码、微信登录与绑定。
 * 先清理过期记录，仅持久化摘要；原文交由邮件链接或 OAuth state 携带。
 */
export async function issueToken(kind, userId = null) {
  const token = randomBytes(32).toString('hex')
  await q('DELETE FROM auth_tokens WHERE expires_at<UTC_TIMESTAMP()')
  await q('INSERT INTO auth_tokens(token_hash,user_id,kind,expires_at) VALUES(?,?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 15 MINUTE))', [hashToken(token), userId, kind])
  return token
}

/**
 * 在事务中锁定并消费指定类型的一次性令牌。
 * 删除令牌与 work 回调共用同一连接；业务失败一起回滚，避免令牌被并发重复使用。
 */
export async function consumeToken(token, kind, work) {
  return transaction(async (db) => {
    const rows = await q('SELECT * FROM auth_tokens WHERE token_hash=? AND kind=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE', [hashToken(token), kind], db)
    ensure(rows.length, 400, 'TOKEN_EXPIRED', '验证码或授权已过期，请重新发起')
    await q('DELETE FROM auth_tokens WHERE token_hash=?', [hashToken(token)], db)
    return work(rows[0], db)
  })
}

/**
 * 通过一次性重置令牌修改密码，同时撤销该用户全部登录会话。
 * 密码哈希先在事务外计算；令牌消费、密码更新和会话清理在同一事务完成。
 */
export async function resetPassword(token, password) {
  const hash = await bcrypt.hash(password, 12)
  await consumeToken(token, 'password_reset', async (t, db) => {
    await q('UPDATE users SET password_hash=?,email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP()) WHERE id=?', [hash, t.user_id], db)
    await q('DELETE FROM sessions WHERE user_id=?', [t.user_id], db)
  })
}
