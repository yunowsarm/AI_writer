/** 开发演示扫码：随机设备凭据识别同一浏览器，不获取微信身份；生产环境始终禁用。 */
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { q, transaction } from '../../db/index.js'
import { config } from '../../config.js'
import { ensure } from '../../shared/errors.js'
import { hashToken, createSession } from './service.js'
export const demoQrRouter = Router()
export const demoQrEnabled = () => !config.production && process.env.DEMO_QR_LOGIN !== 'false'
const token = z.string().regex(/^[a-f0-9]{64}$/)
const random = () => randomBytes(32).toString('hex')
const cookieOptions = { httpOnly: true, sameSite: 'lax', path: '/api/auth/demo-qr' }
demoQrRouter.use('/demo-qr', (req, res, next) => {
  ensure(demoQrEnabled(), 404, 'DEMO_DISABLED', '演示扫码仅在开发环境开放')
  res.set('Cache-Control', 'no-store')
  next()
})

/** 创建两分钟有效的扫码票据，电脑持有独立密钥，二维码不能直接换取电脑会话。 */
demoQrRouter.post('/demo-qr', async (req, res) => {
  const ticket = random(),
    secret = random()
  await q('DELETE FROM demo_qr_tickets WHERE expires_at<UTC_TIMESTAMP()')
  await q('INSERT INTO demo_qr_tickets(ticket_hash,computer_hash,expires_at) VALUES(?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 2 MINUTE))', [hashToken(ticket), hashToken(secret)])
  res.cookie('demo_pc_' + ticket.slice(0, 16), secret, { ...cookieOptions, maxAge: 120000 })
  res.json({ ticket, expiresIn: 120 })
})

/** 手机明确确认后，首次设备创建普通演示用户，老设备复用绑定；刷新不会重复注册。 */
demoQrRouter.post('/demo-qr/confirm', async (req, res) => {
  const ticket = token.parse(req.body.ticket)
  const device = /^[a-f0-9]{64}$/.test(req.cookies?.demo_device || '') ? req.cookies.demo_device : random()
  const result = await transaction(async (db) => {
    const [row] = await q('SELECT *,expires_at>UTC_TIMESTAMP() valid FROM demo_qr_tickets WHERE ticket_hash=? FOR UPDATE', [hashToken(ticket)], db)
    ensure(row?.valid && !row.used, 400, 'QR_EXPIRED', '二维码已过期，请在电脑上刷新')
    if (row.user_id) {
      ensure(row.device_hash === hashToken(device), 409, 'QR_CONFIRMED', '此二维码已由另一设备确认')
      return { registered: false }
    }
    const [known] = await q('SELECT user_id FROM demo_devices WHERE device_hash=?', [hashToken(device)], db)
    let userId = known?.user_id
    if (!userId) {
      const created = await q('INSERT INTO users(nickname) VALUES(?)', ['演示创作者-' + random().slice(0, 6)], db)
      userId = created.insertId
      await q('INSERT INTO demo_devices(device_hash,user_id) VALUES(?,?)', [hashToken(device), userId], db)
    }
    const [user] = await q('SELECT status FROM users WHERE id=?', [userId], db)
    ensure(user?.status === 'active', 403, 'ACCOUNT_DISABLED', '演示账号已禁用')
    await q('UPDATE demo_qr_tickets SET user_id=?,device_hash=? WHERE ticket_hash=?', [userId, hashToken(device), hashToken(ticket)], db)
    return { registered: !known }
  })
  res.cookie('demo_device', device, { ...cookieOptions, maxAge: 90 * 86400000 })
  res.json({ ok: true, ...result })
})

/** 只有创建二维码的电脑可查询和消费；回传窗口会话，二维码不能重放。 */
demoQrRouter.post('/demo-qr/status', async (req, res) => {
  const ticket = token.parse(req.body.ticket)
  const secret = req.cookies?.['demo_pc_' + ticket.slice(0, 16)] || ''
  const [row] = await q('SELECT *,expires_at>UTC_TIMESTAMP() valid FROM demo_qr_tickets WHERE ticket_hash=?', [hashToken(ticket)])
  ensure(row?.valid && !row.used && row.computer_hash === hashToken(secret), 400, 'QR_EXPIRED', '二维码失效，请刷新重试')
  if (!row.user_id) return res.json({ status: 'waiting' })
  const [user] = await q('SELECT status FROM users WHERE id=?', [row.user_id])
  ensure(user?.status === 'active', 403, 'ACCOUNT_DISABLED', '演示账号已禁用')
  const consumed = await q('UPDATE demo_qr_tickets SET used=TRUE WHERE ticket_hash=? AND used=FALSE', [hashToken(ticket)])
  ensure(consumed.affectedRows, 409, 'QR_USED', '二维码已使用')
  await createSession(row.user_id, res, req.sessionScope)
  res.json({ status: 'completed' })
})
