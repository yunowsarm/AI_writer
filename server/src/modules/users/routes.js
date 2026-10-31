/** 个人中心：资料、创作统计、浏览历史，不接收客户端传来的用户归属。 */
import { Router } from 'express'
import { z } from 'zod'
import { q } from '../../db/index.js'
import { requireUser, publicUser } from '../auth/service.js'
import { avatarRouter } from './avatar.js'
export const usersRouter = Router()
usersRouter.use(requireUser)
usersRouter.use('/avatar', avatarRouter)

/**
 * GET /api/me
 * 用途：获取当前用户的公开资料字段。
 * 权限：已登录用户。
 * 入参：无，身份由会话确定。
 * 返回：id、邮箱、昵称、简介、角色及创建时间。
 */
usersRouter.get('/', async (req, res) => res.json(publicUser(req.user)))

/**
 * PATCH /api/me
 * 用途：修改当前用户的昵称和简介。
 * 权限：已登录用户，仅当前账号。
 * 入参：Body：nickname（1～40 字符）、bio（最多 500 字符）。
 * 返回：更新后的脱敏用户资料。
 */
usersRouter.patch('/', async (req, res) => {
  const b = z.object({ nickname: z.string().trim().min(1).max(40), bio: z.string().max(500) }).parse(req.body)
  await q('UPDATE users SET nickname=?,bio=? WHERE id=?', [b.nickname, b.bio, req.user.id])
  res.json(publicUser({ ...req.user, ...b }))
})

/**
 * GET /api/me/stats
 * 用途：汇总当前账号的作品数、字数、收藏数、历史数与创作天数。
 * 权限：已登录用户，仅当前账号。
 * 入参：无。
 * 返回：scripts、words、favorites、history、days。
 */
usersRouter.get('/stats', async (req, res) => {
  const [scripts] = await q('SELECT COUNT(*) count FROM scripts WHERE owner_id=? AND deleted_at IS NULL', [req.user.id])
  const [words] = await q('SELECT COALESCE(SUM(CHAR_LENGTH(e.content_text)),0) count FROM episodes e JOIN scripts s ON s.id=e.script_id WHERE s.owner_id=? AND s.deleted_at IS NULL', [req.user.id])
  const [favorites] = await q('SELECT COUNT(*) count FROM favorites WHERE user_id=?', [req.user.id])
  const [history] = await q('SELECT COUNT(*) count FROM browse_history WHERE user_id=?', [req.user.id])
  const [days] = await q('SELECT COUNT(DISTINCT DATE(v.created_at)) count FROM versions v JOIN episodes e ON e.id=v.episode_id JOIN scripts s ON s.id=e.script_id WHERE s.owner_id=?', [req.user.id])
  res.json({
    scripts: scripts.count,
    words: Number(words.count),
    favorites: favorites.count,
    history: history.count,
    days: days.count
  })
})

/**
 * GET /api/me/history
 * 用途：读取当前账号最近 50 条仍可公开访问的剧本浏览历史。
 * 权限：已登录用户，仅当前账号。
 * 入参：无。
 * 返回：剧本 ID、公开标题、题材及浏览时间列表。
 */
usersRouter.get('/history', async (req, res) =>
  res.json(
    await q(
      "SELECT s.id,JSON_UNQUOTE(JSON_EXTRACT(s.published_json,'$.title')) title,s.genre,h.viewed_at FROM browse_history h JOIN scripts s ON s.id=h.script_id WHERE h.user_id=? AND s.visibility=? AND s.deleted_at IS NULL ORDER BY h.viewed_at DESC LIMIT 50",
      [req.user.id, 'public']
    )
  )
)

/**
 * DELETE /api/me/history
 * 用途：清空当前用户的浏览历史。
 * 权限：已登录用户，仅当前账号。
 * 入参：无。
 * 返回：ok。
 */
usersRouter.delete('/history', async (req, res) => {
  await q('DELETE FROM browse_history WHERE user_id=?', [req.user.id])
  res.json({ ok: true })
})
