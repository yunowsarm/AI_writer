/** 广场、评论、点赞与收藏：写操作要求登录，访问始终重新检查可见性。 */
import { Router } from 'express'
import { z } from 'zod'
import { rateLimit } from 'express-rate-limit'
import { q, json } from '../../db/index.js'
import { requireUser } from '../auth/service.js'
import { paging, idSchema } from '../../shared/validation.js'
import { ensure } from '../../shared/errors.js'
import { publicScript, publicSummary, publicWhere } from './service.js'
import { visibleTemplate } from '../templates/routes.js'
export const communityRouter = Router(),
  favoritesRouter = Router()
const counts = `(SELECT COUNT(*) FROM likes l WHERE l.script_id=s.id) like_count,(SELECT COUNT(*) FROM comments c WHERE c.script_id=s.id AND c.status='active') comment_count,(SELECT COUNT(*) FROM analytics_events a WHERE a.target_id=s.id AND a.event_type='read') views`

/**
 * GET /api/public/scripts
 * 用途：分页搜索已公开剧本，支持按最新或热度排序。
 * 权限：允许匿名，仅展示审核后的快照且作者账号须启用。
 * 入参：Query：page、size、q、genre、sort。
 * 返回：items、total，登录时附带本人点赞和收藏状态。
 */
communityRouter.get('/scripts', async (req, res) => {
  const p = paging(req.query)
  const where =
    publicWhere +
    " AND (?='' OR JSON_UNQUOTE(JSON_EXTRACT(s.published_json,'$.genre'))=?) AND (?='' OR JSON_UNQUOTE(JSON_EXTRACT(s.published_json,'$.title')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(s.published_json,'$.tags')) LIKE ? OR JSON_UNQUOTE(JSON_EXTRACT(s.published_json,'$.synopsis')) LIKE ?)"
  const params = [p.genre, p.genre, p.q, '%' + p.q + '%', '%' + p.q + '%', '%' + p.q + '%']
  const [total] = await q(
    'SELECT COUNT(*) count FROM scripts s JOIN users u ON u.id=s.owner_id WHERE ' + where,
    params
  )
  const items = await q(
    `SELECT s.*,u.nickname,${counts},EXISTS(SELECT 1 FROM likes WHERE script_id=s.id AND user_id=?) liked,EXISTS(SELECT 1 FROM favorites WHERE target_type='script' AND target_id=s.id AND user_id=?) favorited FROM scripts s JOIN users u ON u.id=s.owner_id WHERE ${where} ORDER BY ${p.sort === 'hot' ? '(like_count*3+comment_count*2+views*.1) DESC,' : ''}s.updated_at DESC LIMIT ${p.size} OFFSET ${p.offset}`,
    [req.user?.id || 0, req.user?.id || 0, ...params]
  )
  res.json({ items: items.map(publicSummary), total: total.count })
})

/**
 * GET /api/public/scripts/:id
 * 用途：读取公开剧本快照、评论及互动状态，并记录阅读事件。
 * 权限：允许匿名；登录时另更新个人浏览历史。
 * 入参：Path：id。
 * 返回：公开正文、作者、评论、点赞数及本人互动状态。
 */
communityRouter.get('/scripts/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const row = await publicScript(id)
  if (req.user)
    await q(
      'INSERT INTO browse_history(user_id,script_id) VALUES(?,?) ON DUPLICATE KEY UPDATE viewed_at=CURRENT_TIMESTAMP(3)',
      [req.user.id, id]
    )
  await q('INSERT INTO analytics_events(event_type,user_id,target_id) VALUES(?,?,?)', [
    'read',
    req.user?.id || null,
    id,
  ])
  const comments = await q(
    "SELECT c.id,c.body,c.user_id,c.created_at,u.nickname,IF(u.avatar_version IS NULL,NULL,CONCAT('/api/avatars/',u.id,'?v=',u.avatar_version)) avatarUrl FROM comments c JOIN users u ON u.id=c.user_id WHERE c.script_id=? AND c.status='active' ORDER BY c.id DESC LIMIT 100",
    [id]
  )
  const [like] = await q('SELECT COUNT(*) n FROM likes WHERE script_id=?', [id])
  const [mine] = await q('SELECT COUNT(*) n FROM likes WHERE script_id=? AND user_id=?', [
    id,
    req.user?.id || 0,
  ])
  const [fav] = await q(
    "SELECT COUNT(*) n FROM favorites WHERE target_type='script' AND target_id=? AND user_id=?",
    [id, req.user?.id || 0]
  )
  res.json({
    ...json(row.published_json),
    author: row.nickname,
    authorId: row.owner_id,
    comments,
    likes: like.n,
    liked: !!mine.n,
    favorited: !!fav.n,
  })
})

/**
 * PUT /api/public/scripts/:id/like
 * 用途：为仍可公开访问的剧本点赞，重复请求不重复计数。
 * 权限：已登录用户。
 * 入参：Path：id。
 * 返回：ok。
 */
communityRouter.put('/scripts/:id/like', requireUser, async (req, res) => {
  const id = idSchema.parse(req.params.id)
  await publicScript(id)
  await q('INSERT IGNORE INTO likes VALUES(?,?)', [req.user.id, id])
  res.json({ ok: true })
})

/**
 * DELETE /api/public/scripts/:id/like
 * 用途：取消当前用户对剧本的点赞。
 * 权限：已登录用户。
 * 入参：Path：id。
 * 返回：ok，重复取消也返回成功。
 */
communityRouter.delete('/scripts/:id/like', requireUser, async (req, res) => {
  await q('DELETE FROM likes WHERE user_id=? AND script_id=?', [req.user.id, idSchema.parse(req.params.id)])
  res.json({ ok: true })
})
const commentLimit = rateLimit({
  windowMs: 60000,
  limit: 12,
  message: { code: 'COMMENT_RATE_LIMIT', message: '评论过于频繁，请稍后重试' },
})

/**
 * POST /api/public/scripts/:id/comments
 * 用途：向公开剧本提交评论。
 * 权限：已登录用户，受评论频率限制。
 * 入参：Path：id；Body：body（去除两端空白后 1～1000 字符）。
 * 返回：201，新评论 id。
 */
communityRouter.post('/scripts/:id/comments', requireUser, commentLimit, async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = z.object({ body: z.string().trim().min(1).max(1000) }).parse(req.body)
  await publicScript(id)
  const result = await q('INSERT INTO comments(user_id,script_id,body) VALUES(?,?,?)', [
    req.user.id,
    id,
    b.body,
  ])
  res.status(201).json({ id: result.insertId })
})

/**
 * DELETE /api/public/comments/:id
 * 用途：将评论设为隐藏，保留原始记录。
 * 权限：已登录评论作者或管理员。
 * 入参：Path：id，评论 ID。
 * 返回：ok。
 */
communityRouter.delete('/comments/:id', requireUser, async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const rows = await q('SELECT user_id FROM comments WHERE id=?', [id])
  ensure(
    rows.length && (rows[0].user_id === req.user.id || req.user.role === 'admin'),
    404,
    'COMMENT_NOT_FOUND',
    '评论不存在或无权操作'
  )
  await q("UPDATE comments SET status='hidden' WHERE id=?", [id])
  res.json({ ok: true })
})

/**
 * POST /api/public/scripts/:id/report
 * 用途：举报仍可公开访问的剧本。
 * 权限：已登录用户，受评论频率限制。
 * 入参：Path：id；Body：reason（2～500 字符）。
 * 返回：201，ok。
 */
communityRouter.post('/scripts/:id/report', requireUser, commentLimit, async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const { reason } = z.object({ reason: z.string().trim().min(2).max(500) }).parse(req.body)
  await publicScript(id)
  await q('INSERT INTO reports(user_id,script_id,reason) VALUES(?,?,?)', [req.user.id, id, reason])
  res.status(201).json({ ok: true })
})
favoritesRouter.use(requireUser)

/**
 * GET /api/favorites
 * 用途：分页读取本人收藏，逐项重新检查内容可见性。
 * 权限：已登录用户，仅本人收藏。
 * 入参：Query：page、size。
 * 返回：items、total；不可用内容返回 unavailable 标记。
 */
favoritesRouter.get('/', async (req, res) => {
  const p = paging(req.query)
  const rows = await q(
    `SELECT * FROM favorites WHERE user_id=? ORDER BY created_at DESC LIMIT ${p.size} OFFSET ${p.offset}`,
    [req.user.id]
  )
  const items = []
  for (const r of rows) {
    try {
      if (r.target_type === 'script') {
        const s = await publicScript(r.target_id)
        items.push({ ...publicSummary(s), type: 'script' })
      } else items.push({ ...(await visibleTemplate(r.target_id, req.user.id)), type: 'template' })
    } catch (e) {
      if (e.status !== 404) throw e
      items.push({ id: r.target_id, title: '内容已下架或不再公开', type: r.target_type, unavailable: true })
    }
  }
  const [total] = await q('SELECT COUNT(*) n FROM favorites WHERE user_id=?', [req.user.id])
  res.json({ items, total: total.n })
})

/**
 * PUT /api/favorites/:type/:id
 * 用途：收藏可访问的剧本或模板，重复请求不创建重复记录。
 * 权限：已登录用户。
 * 入参：Path：type=script/template、id。
 * 返回：ok。
 */
favoritesRouter.put('/:type/:id', async (req, res) => {
  const type = z.enum(['script', 'template']).parse(req.params.type),
    id = idSchema.parse(req.params.id)
  if (type === 'script') await publicScript(id)
  else await visibleTemplate(id, req.user.id)
  await q('INSERT IGNORE INTO favorites(user_id,target_type,target_id) VALUES(?,?,?)', [
    req.user.id,
    type,
    id,
  ])
  res.json({ ok: true })
})

/**
 * DELETE /api/favorites/:type/:id
 * 用途：取消本人收藏；内容下架后仍允许移除收藏。
 * 权限：已登录用户。
 * 入参：Path：type=script/template、id。
 * 返回：ok。
 */
favoritesRouter.delete('/:type/:id', async (req, res) => {
  const type = z.enum(['script', 'template']).parse(req.params.type)
  await q('DELETE FROM favorites WHERE user_id=? AND target_type=? AND target_id=?', [
    req.user.id,
    type,
    idSchema.parse(req.params.id),
  ])
  res.json({ ok: true })
})
