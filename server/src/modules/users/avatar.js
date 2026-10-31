/** 头像接口：图片在后端重新解码并压缩，数据库存储，迁移项目时无需另拷上传目录。 */
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { z } from 'zod'
import { q, transaction } from '../../db/index.js'
import { ensure } from '../../shared/errors.js'
import { publicUser, requireUser } from '../auth/service.js'

export const avatarRouter = Router()
export const avatarReadRouter = Router()
avatarRouter.use(requireUser)

/** 解码受限大小的图片，限制解码像素，去除元数据并输出统一的 512 像素 WebP。 */
export async function normalizeAvatar(image) {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
  ensure(match, 400, 'AVATAR_INVALID', '请选择 JPG、PNG 或 WebP 图片')
  const bytes = Buffer.from(match[2], 'base64')
  ensure(bytes.length > 0 && bytes.length <= 512 * 1024, 400, 'AVATAR_TOO_LARGE', '头像图片过大，请重新选择或压缩')
  ensure(bytes.toString('base64') === match[2], 400, 'AVATAR_INVALID', '图片编码无效')
  try {
    const source = sharp(bytes, { limitInputPixels: 16 * 1024 * 1024, failOn: 'warning' })
    const metadata = await source.metadata()
    ensure(metadata.format === match[1] && (!metadata.pages || metadata.pages === 1), 400, 'AVATAR_INVALID', '仅支持静态 JPG、PNG 或 WebP 图片')
    return await source.rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 85 }).toBuffer()
  } catch (error) {
    if (error.status) throw error
    ensure(false, 400, 'AVATAR_INVALID', '图片无法读取，请选择完整的 JPG、PNG 或 WebP 图片')
  }
}

/** PUT /api/me/avatar：登录用户更新本人头像；任何传入的用户 ID 都不会用于确定归属。 */
avatarRouter.put('/', async (req, res) => {
  const { image } = z.object({ image: z.string().min(1).max(720000) }).parse(req.body)
  const content = await normalizeAvatar(image)
  const version = randomBytes(16).toString('hex')
  const user = await transaction(async (db) => {
    await q('SELECT id FROM users WHERE id=? FOR UPDATE', [req.user.id], db)
    await q('INSERT INTO user_avatars(user_id,content) VALUES(?,?) ON DUPLICATE KEY UPDATE content=VALUES(content)', [req.user.id, content], db)
    await q('UPDATE users SET avatar_version=? WHERE id=?', [version, req.user.id], db)
    return (await q('SELECT * FROM users WHERE id=?', [req.user.id], db))[0]
  })
  res.json(publicUser(user))
})

/** DELETE /api/me/avatar：移除本人的上传图片，恢复昵称首字头像。 */
avatarRouter.delete('/', async (req, res) => {
  const user = await transaction(async (db) => {
    await q('SELECT id FROM users WHERE id=? FOR UPDATE', [req.user.id], db)
    await q('DELETE FROM user_avatars WHERE user_id=?', [req.user.id], db)
    await q('UPDATE users SET avatar_version=NULL WHERE id=?', [req.user.id], db)
    return (await q('SELECT * FROM users WHERE id=?', [req.user.id], db))[0]
  })
  res.json(publicUser(user))
})

/** GET /api/avatars/:id：公开头像图片；禁用、删除或恢复默认后不再返回旧图片。 */
avatarReadRouter.get('/:id', async (req, res) => {
  const id = z.coerce.number().int().positive().parse(req.params.id)
  const [row] = await q("SELECT a.content,u.avatar_version FROM user_avatars a JOIN users u ON u.id=a.user_id WHERE a.user_id=? AND u.status='active'", [id])
  ensure(row, 404, 'AVATAR_NOT_FOUND', '头像不存在')
  res.set('Cache-Control', 'no-cache')
  res.set('ETag', '"' + row.avatar_version + '"')
  res.type('image/webp').send(row.content)
})
