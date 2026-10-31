/** 邮箱验证码：按用途隔离、十分钟有效、单次消费与错误次数限制。验证码不写日志或接口响应。 */
import { Router } from 'express'
import { randomInt, createHmac } from 'node:crypto'
import { z } from 'zod'
import nodemailer from 'nodemailer'
import bcrypt from 'bcryptjs'
import { config } from '../../config.js'
import { q, transaction } from '../../db/index.js'
import { ensure } from '../../shared/errors.js'
import { createSession, publicUser, requireUser } from './service.js'
export const emailRouter = Router()
const input = z.object({
  email: z
    .string()
    .trim()
    .email()
    .max(190)
    .transform((s) => s.toLowerCase()),
  purpose: z.enum(['register', 'login', 'reset', 'verify'])
})
export const emailReady = () => !!(config.smtp.host && config.smtp.from && config.smtp.auth?.user && config.smtp.auth?.pass)
const digest = (email, purpose, code) =>
  createHmac('sha256', config.smtp.auth.pass)
    .update(email + ':' + purpose + ':' + code)
    .digest('hex')

/** 锁定验证码并计次；错误计数先提交后报错，防止事务回滚令暴力尝试无限重试。 */
export async function consumeEmailCode(email, purpose, code, work) {
  const result = await transaction(async (db) => {
    const [row] = await q('SELECT *,expires_at>UTC_TIMESTAMP() valid FROM email_codes WHERE email=? AND purpose=? FOR UPDATE', [email, purpose], db)
    if (!row || !row.valid || row.attempts >= 5) return { invalid: true }
    if (row.code_hash !== digest(email, purpose, code)) {
      await q('UPDATE email_codes SET attempts=attempts+1 WHERE email=? AND purpose=?', [email, purpose], db)
      return { invalid: true }
    }
    const value = await work(db)
    await q('DELETE FROM email_codes WHERE email=? AND purpose=?', [email, purpose], db)
    return { value }
  })
  ensure(!result.invalid, 400, 'EMAIL_CODE_INVALID', '验证码错误、过期或尝试次数过多，请重新获取')
  return result.value
}

/** POST /api/auth/email-code：发送六位验证码，六十秒内不可重发，同一邮箱各用途独立。 */
emailRouter.post('/email-code', async (req, res) => {
  ensure(emailReady(), 503, 'EMAIL_NOT_CONFIGURED', '请先配置完整 SMTP 邮箱服务')
  const { email, purpose } = input.parse(req.body)
  if (purpose === 'verify') {
    ensure(req.user, 401, 'UNAUTHENTICATED', '请先登录再验证账号邮箱')
    ensure(req.user.email?.toLowerCase() === email, 403, 'EMAIL_MISMATCH', '只能验证当前账号的邮箱')
    ensure(!req.user.email_verified_at, 409, 'EMAIL_ALREADY_VERIFIED', '当前邮箱已验证，无需重复操作')
  } else {
    const [user] = await q('SELECT id,status FROM users WHERE email=?', [email])
    if (purpose === 'register') ensure(!user, 409, 'EMAIL_ALREADY_REGISTERED', '该邮箱已注册，请直接登录或找回密码')
    else ensure(user?.status === 'active', 400, 'ACCOUNT_UNAVAILABLE', '账号不存在或不可用，请检查邮箱')
  }
  const code = String(randomInt(100000, 1000000))
  await transaction(async (db) => {
    await q('INSERT IGNORE INTO email_codes(email,purpose,code_hash,sent_at,expires_at) VALUES(?,?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 DAY),UTC_TIMESTAMP())', [email, purpose, '0'.repeat(64)], db)
    const [row] = await q('SELECT TIMESTAMPDIFF(SECOND,sent_at,UTC_TIMESTAMP()) elapsed FROM email_codes WHERE email=? AND purpose=? FOR UPDATE', [email, purpose], db)
    ensure(row.elapsed >= 60, 429, 'EMAIL_CODE_COOLDOWN', '请六十秒后再获取验证码')
    await q(
      'UPDATE email_codes SET code_hash=?,attempts=0,sent_at=UTC_TIMESTAMP(),expires_at=DATE_ADD(UTC_TIMESTAMP(),INTERVAL 10 MINUTE) WHERE email=? AND purpose=?',
      [digest(email, purpose, code), email, purpose],
      db
    )
  })
  try {
    const delivery = await nodemailer.createTransport({ ...config.smtp, connectionTimeout: 10000, socketTimeout: 15000 }).sendMail({
      from: config.smtp.from,
      to: email,
      subject: '短剧创作系统 · 邮箱验证码',
      text: `你的${{ register: '注册', login: '登录', reset: '重置密码', verify: '邮箱验证' }[purpose]}验证码为：${code}，十分钟内有效。请勿向他人透露；非本人操作请忽略。`
    })
    // SMTP 可能完成会话但拒绝收件人，不能将其提示为发送成功。
    ensure(
      delivery.accepted?.some((recipient) => String(recipient).toLowerCase() === email),
      502,
      'EMAIL_SEND_FAILED',
      '收件地址未被邮件服务器接受'
    )
  } catch {
    await q('DELETE FROM email_codes WHERE email=? AND purpose=? AND code_hash=?', [email, purpose, digest(email, purpose, code)])
    ensure(false, 502, 'EMAIL_SEND_FAILED', '验证码发送失败，请检查邮箱配置后重试')
  }
  res.json({ message: '验证码已发送，十分钟内有效', retryAfter: 60 })
})

/** POST /api/auth/email-login：验证码登录已有启用账号，沿用本窗口会话。 */
emailRouter.post('/email-login', async (req, res) => {
  ensure(emailReady(), 503, 'EMAIL_NOT_CONFIGURED', '邮箱服务未配置')
  const { email, code } = input
    .pick({ email: true })
    .extend({ code: z.string().regex(/^\d{6}$/) })
    .parse(req.body)
  const user = await consumeEmailCode(email, 'login', code, async (db) => {
    const [user] = await q("SELECT * FROM users WHERE email=? AND status='active'", [email], db)
    ensure(user, 400, 'ACCOUNT_UNAVAILABLE', '账号不存在或不可用，请先注册')
    await q('UPDATE users SET email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP()) WHERE id=?', [user.id], db)
    return (await q('SELECT * FROM users WHERE id=?', [user.id], db))[0]
  })
  await createSession(user.id, res, req.sessionScope)
  res.json(publicUser(user))
})

/** POST /api/auth/email-reset：验证码和密码更新共用事务，并撤销所有旧会话。 */
emailRouter.post('/email-reset', async (req, res) => {
  ensure(emailReady(), 503, 'EMAIL_NOT_CONFIGURED', '邮箱服务未配置')
  const { email, code, password } = input
    .pick({ email: true })
    .extend({ code: z.string().regex(/^\d{6}$/), password: z.string().min(8).max(128) })
    .parse(req.body)
  const hash = await bcrypt.hash(password, 12)
  await consumeEmailCode(email, 'reset', code, async (db) => {
    const [user] = await q("SELECT id FROM users WHERE email=? AND status='active' FOR UPDATE", [email], db)
    ensure(user, 400, 'ACCOUNT_UNAVAILABLE', '账号不存在或不可用')
    await q('UPDATE users SET password_hash=?,email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP()) WHERE id=?', [hash, user.id], db)
    await q('DELETE FROM sessions WHERE user_id=?', [user.id], db)
  })
  res.json({ ok: true })
})

/** POST /api/auth/email-verify：已登录旧账号验证当前邮箱，不能传入他人邮箱或替换账号邮箱。 */
emailRouter.post('/email-verify', requireUser, async (req, res) => {
  ensure(emailReady(), 503, 'EMAIL_NOT_CONFIGURED', '邮箱验证服务尚未配置，请联系管理员')
  ensure(req.user.email, 400, 'EMAIL_REQUIRED', '当前账号尚未绑定邮箱')
  const { code } = z.object({ code: z.string().regex(/^\d{6}$/, '请输入六位邮箱验证码') }).parse(req.body)
  const user = await consumeEmailCode(req.user.email.toLowerCase(), 'verify', code, async (db) => {
    const [current] = await q("SELECT * FROM users WHERE id=? AND status='active' FOR UPDATE", [req.user.id], db)
    ensure(current?.email === req.user.email, 409, 'EMAIL_CHANGED', '账号邮箱已变更，请刷新后重试')
    await q('UPDATE users SET email_verified_at=COALESCE(email_verified_at,UTC_TIMESTAMP()) WHERE id=?', [current.id], db)
    return (await q('SELECT * FROM users WHERE id=?', [current.id], db))[0]
  })
  res.json(publicUser(user))
})
