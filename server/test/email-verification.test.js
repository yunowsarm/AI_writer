/** 邮箱验证回归：独立测试库、模拟邮件投递，不发送真实邮件或修改业务账号。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import nodemailer from 'nodemailer'

process.env.DB_NAME = 'mujian_test'
const { config } = await import('../src/config.js')
const { q, pool } = await import('../src/db/index.js')
const { migrate } = await import('../scripts/migrate.js')
const { authRouter } = await import('../src/modules/auth/routes.js')
const { loadUser } = await import('../src/modules/auth/service.js')
const { errorHandler } = await import('../src/shared/errors.js')

test('注册必须验证邮箱，旧账号可补验，验证码隔离且不可重放', async () => {
  await migrate()
  const marker = randomUUID().replaceAll('-', '').slice(0, 12)
  const emails = ['new', 'old', 'expiry', 'locked', 'sendfail'].map((name) => `${name}-${marker}@example.com`)
  const originalSmtp = config.smtp
  const originalTransport = nodemailer.createTransport
  const messages = []
  let rejectMail = false
  nodemailer.createTransport = () => ({
    async sendMail(message) {
      if (rejectMail) return { accepted: [], rejected: [message.to] }
      messages.push(message)
      return { accepted: [message.to], rejected: [] }
    }
  })
  const app = express()
  app.use(express.json(), cookieParser(), loadUser)
  app.use('/api/auth', authRouter)
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const base = `http://127.0.0.1:${server.address().port}/api/auth`
  const password = 'Test-password-482!'
  const registration = (email, code) => ({ email, password, nickname: '验证测试', code })
  const request = async (path, body, cookie) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) })
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const send = async (email, purpose, cookie) => {
    const response = await request('/email-code', { email, purpose }, cookie)
    assert.equal(response.status, 200, JSON.stringify(response.data))
    assert.equal(JSON.stringify(response.data).includes(messages.at(-1).text.match(/\d{6}/)[0]), false)
    return messages.at(-1).text.match(/\d{6}/)[0]
  }
  try {
    config.smtp = { host: '', from: '', auth: { user: '', pass: '' } }
    let response = await request('/register', registration(emails[0]))
    assert.equal(response.status, 503, 'SMTP 未配置时不得绕过验证码注册')
    assert.equal((await q('SELECT id FROM users WHERE email=?', [emails[0]])).length, 0)
    config.smtp = { host: 'smtp.example.com', from: 'test@example.com', auth: { user: 'test', pass: 'test-only-smtp-key' } }
    assert.equal((await request('/register', registration(emails[0]))).status, 400)
    const code = await send(emails[0], 'register')
    assert.equal((await request('/email-code', { email: emails[0], purpose: 'register' })).status, 429)
    assert.equal((await request('/register', registration(emails[0], code === '000000' ? '000001' : '000000'))).status, 400)
    response = await request('/register', registration(emails[0], code))
    assert.equal(response.status, 201)
    assert.equal(response.data.emailVerified, true)
    assert.ok(response.data.emailVerifiedAt)
    const newCookie = response.cookie
    assert.equal((await q('SELECT * FROM email_codes WHERE email=?', [emails[0]])).length, 0)
    assert.notEqual((await request('/register', registration(emails[0], code))).status, 201)

    const bcrypt = (await import('bcryptjs')).default
    await q('INSERT INTO users(email,password_hash,nickname) VALUES(?,?,?)', [emails[1], await bcrypt.hash(password, 4), '旧账号'])
    response = await request('/login', { email: emails[1], password })
    assert.equal(response.status, 200)
    assert.equal(response.data.emailVerified, false)
    const oldCookie = response.cookie
    assert.equal((await request('/email-code', { email: emails[1], purpose: 'verify' })).status, 401)
    assert.equal((await request('/email-code', { email: emails[0], purpose: 'verify' }, oldCookie)).status, 403)
    const oldCode = await send(emails[1], 'verify', oldCookie)
    assert.equal((await request('/email-verify', { code: oldCode }, newCookie)).status, 400)
    response = await request('/email-verify', { code: oldCode }, oldCookie)
    assert.equal(response.status, 200)
    assert.equal(response.data.emailVerified, true)
    assert.equal((await request('/email-verify', { code: oldCode }, oldCookie)).status, 400)

    await q('UPDATE users SET email_verified_at=NULL WHERE email=?', [emails[1]])
    const loginCode = await send(emails[1], 'login')
    response = await request('/email-login', { email: emails[1], code: loginCode })
    assert.equal(response.status, 200)
    assert.equal(response.data.emailVerified, true)
    assert.equal((await request('/email-login', { email: emails[1], code: loginCode })).status, 400)

    const expiredCode = await send(emails[2], 'register')
    await q('UPDATE email_codes SET expires_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND) WHERE email=?', [emails[2]])
    assert.equal((await request('/register', registration(emails[2], expiredCode))).status, 400)
    const lockedCode = await send(emails[3], 'register')
    for (let i = 0; i < 5; i++) assert.equal((await request('/register', registration(emails[3], '000000'))).status, 400)
    assert.equal((await request('/register', registration(emails[3], lockedCode))).status, 400)

    rejectMail = true
    response = await request('/email-code', { email: emails[4], purpose: 'register' })
    assert.equal(response.status, 502)
    assert.equal((await q('SELECT * FROM email_codes WHERE email=?', [emails[4]])).length, 0)
    rejectMail = false
    await q('UPDATE users SET email_verified_at=NULL WHERE email=?', [emails[1]])
    const resetCode = await send(emails[1], 'reset', oldCookie)
    assert.equal((await request('/email-login', { email: emails[1], code: resetCode })).status, 400, '找回密码验证码不可用于登录')
    response = await request('/email-reset', { email: emails[1], code: resetCode, password: 'Changed-password-783!' })
    assert.equal(response.status, 200)
    assert.ok((await q('SELECT email_verified_at FROM users WHERE email=?', [emails[1]]))[0].email_verified_at)
    assert.equal((await q('SELECT s.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE u.email=?', [emails[1]])).length, 0)
  } finally {
    config.smtp = originalSmtp
    nodemailer.createTransport = originalTransport
    for (const email of emails) {
      await q('DELETE FROM email_codes WHERE email=?', [email])
      await q('DELETE FROM users WHERE email=?', [email])
    }
    await new Promise((resolve) => server.close(resolve))
    await pool.end()
  }
})
