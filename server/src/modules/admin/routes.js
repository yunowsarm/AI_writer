/** 管理模块：独立角色鉴权、内容快照审批、账号禁用与审计日志。 */
import { Router } from 'express'
import { z } from 'zod'
import { q, transaction, json } from '../../db/index.js'
import { requireUser, requireAdmin } from '../auth/service.js'
import { ensure } from '../../shared/errors.js'
import { idSchema, paging } from '../../shared/validation.js'
import { templateSchema, mapTemplate } from '../templates/routes.js'
export const adminRouter = Router()
adminRouter.use(requireUser, requireAdmin)

/**
 * 记录管理员动作、目标和说明；传入 db 时加入当前业务事务。
 */
const audit = (actor, action, target, detail = '', db) => q('INSERT INTO audit_logs(actor_id,action,target_id,detail) VALUES(?,?,?,?)', [actor, action, target, detail], db)

/**
 * GET /api/admin/metrics
 * 用途：读取全站用户、访问、剧本、生成和审核指标及趋势。
 * 权限：管理员。
 * 入参：无。
 * 返回：汇总计数、近七天生成趋势 trend、题材分布 genres。
 */
adminRouter.get('/metrics', async (req, res) => {
  const [counts] = await q(
    "SELECT (SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM analytics_events WHERE event_type='visit') visits,(SELECT COUNT(*) FROM scripts WHERE deleted_at IS NULL) scripts,(SELECT COUNT(*) FROM ai_jobs) generations,(SELECT COUNT(*) FROM ai_jobs WHERE status='completed') completed,(SELECT COUNT(*) FROM reviews WHERE status='pending') pending"
  )
  const trend = await q(
    "SELECT DATE(created_at) day,COUNT(*) count,SUM(status='completed') completed FROM ai_jobs WHERE created_at>=DATE_SUB(UTC_DATE(),INTERVAL 6 DAY) GROUP BY DATE(created_at) ORDER BY day"
  )
  const genres = await q('SELECT genre,COUNT(*) count FROM scripts WHERE deleted_at IS NULL GROUP BY genre ORDER BY count DESC')
  res.json({ ...counts, trend, genres })
})

/**
 * GET /api/admin/users
 * 用途：分页搜索用户及其作品数量，不返回密码哈希。
 * 权限：管理员。
 * 入参：Query：page、size、q（邮箱或昵称）。
 * 返回：items、total。
 */
adminRouter.get('/users', async (req, res) => {
  const p = paging(req.query)
  const where = "(?='' OR email LIKE ? OR nickname LIKE ?)"
  const params = [p.q, '%' + p.q + '%', '%' + p.q + '%']
  const items = await q(
    `SELECT id,email,nickname,role,status,created_at,(SELECT COUNT(*) FROM scripts s WHERE s.owner_id=users.id AND s.deleted_at IS NULL) scripts FROM users WHERE ${where} ORDER BY id DESC LIMIT ${p.size} OFFSET ${p.offset}`,
    params
  )
  const [total] = await q('SELECT COUNT(*) n FROM users WHERE ' + where, params)
  res.json({ items, total: total.n })
})

/**
 * PATCH /api/admin/users/:id
 * 用途：启用或禁用普通账号；禁用时撤销会话并记录审计。
 * 权限：管理员，不能操作当前账号或其他管理员。
 * 入参：Path：id；Body：status=active/disabled。
 * 返回：ok。
 */
adminRouter.patch('/users/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = z.object({ status: z.enum(['active', 'disabled']) }).parse(req.body)
  ensure(id !== req.user.id, 400, 'SELF_DISABLE', '不能禁用当前管理员账号')
  await transaction(async (db) => {
    const rows = await q('SELECT id,role FROM users WHERE id=? FOR UPDATE', [id], db)
    ensure(rows.length, 404, 'USER_NOT_FOUND', '用户不存在')
    ensure(rows[0].role !== 'admin', 403, 'ADMIN_PROTECTED', '管理员账号不允许在此禁用')
    await q('UPDATE users SET status=? WHERE id=?', [b.status, id], db)
    if (b.status === 'disabled') await q('DELETE FROM sessions WHERE user_id=?', [id], db)
    await audit(req.user.id, 'user.' + b.status, id, '', db)
  })
  res.json({ ok: true })
})

/**
 * GET /api/admin/templates
 * 用途：获取全部官方模板，包括已下架模板。
 * 权限：管理员。
 * 入参：无。
 * 返回：官方模板列表。
 */
adminRouter.get('/templates', async (req, res) => res.json((await q("SELECT * FROM templates WHERE kind='official' ORDER BY id DESC")).map(mapTemplate)))

/**
 * POST /api/admin/templates
 * 用途：新增官方模板并记录审计。
 * 权限：管理员。
 * 入参：Body：title、genre、description、params，可选 outline。
 * 返回：201，新模板 id。
 */
adminRouter.post('/templates', async (req, res) => {
  const b = templateSchema.parse(req.body)
  const r = await q('INSERT INTO templates(kind,title,genre,description,params,outline) VALUES(?,?,?,?,?,?)', ['official', b.title, b.genre, b.description, JSON.stringify(b.params), b.outline])
  await audit(req.user.id, 'template.create', r.insertId)
  res.status(201).json({ id: r.insertId })
})

/**
 * PATCH /api/admin/templates/:id
 * 用途：修改官方模板的内容及上下架状态，并记录审计。
 * 权限：管理员，仅 official 类型。
 * 入参：Path：id；Body：模板字段及 status=active/offline。
 * 返回：ok。
 */
adminRouter.patch('/templates/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = templateSchema.extend({ status: z.enum(['active', 'offline']) }).parse(req.body)
  const r = await q("UPDATE templates SET title=?,genre=?,description=?,params=?,outline=?,status=? WHERE id=? AND kind='official'", [
    b.title,
    b.genre,
    b.description,
    JSON.stringify(b.params),
    b.outline,
    b.status,
    id
  ])
  ensure(r.affectedRows, 404, 'TEMPLATE_NOT_FOUND', '官方模板不存在')
  await audit(req.user.id, 'template.update', id, b.status)
  res.json({ ok: true })
})

/**
 * GET /api/admin/reviews
 * 用途：分页查询审核申请及提交时冻结的正文快照。
 * 权限：管理员。
 * 入参：Query：page、size、status，默认 pending。
 * 返回：items、total，快照通过 snapshot 字段返回。
 */
adminRouter.get('/reviews', async (req, res) => {
  const status = z.enum(['pending', 'approved', 'rejected', 'cancelled', 'all']).default('pending').parse(req.query.status)
  const p = paging(req.query)
  // 仅对小字段排序分页；快照可能含整部长剧本，不能携带它进入 MySQL filesort。
  const ids = await q(`SELECT id FROM reviews WHERE (?='all' OR status=?) ORDER BY id DESC LIMIT ${p.size} OFFSET ${p.offset}`, [status, status])
  const rows = ids.length
    ? await q(
        `SELECT r.*,u.nickname FROM reviews r JOIN users u ON u.id=r.submitted_by WHERE r.id IN (${ids.map(() => '?').join(',')})`,
        ids.map((r) => r.id)
      )
    : []
  const items = ids.map(({ id }) => rows.find((r) => r.id === id)).filter(Boolean)
  const [total] = await q("SELECT COUNT(*) n FROM reviews WHERE (?='all' OR status=?)", [status, status])
  res.json({
    items: items.map((r) => ({ ...r, snapshot: json(r.snapshot_json), snapshot_json: undefined })),
    total: total.n
  })
})

/**
 * POST /api/admin/reviews/:id/decision
 * 用途：审批待审快照；通过后将该快照设为公开内容。
 * 权限：管理员，同一申请只能处理一次。
 * 入参：Path：id；Body：approve、reason，驳回原因至少 2 字符。
 * 返回：ok；已处理或撤回的申请返回 409。
 */
adminRouter.post('/reviews/:id/decision', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = z.object({ approve: z.boolean(), reason: z.string().trim().max(500).default('') }).parse(req.body)
  ensure(b.approve || b.reason.length >= 2, 400, 'REASON_REQUIRED', '驳回时请填写原因')
  await transaction(async (db) => {
    const found = await q('SELECT script_id FROM reviews WHERE id=?', [id], db)
    ensure(found.length, 404, 'REVIEW_NOT_FOUND', '审核不存在')
    // 与提交审核保持“先剧本、后申请”的加锁顺序，再检查待审状态，避免重复审批。
    await q('SELECT id FROM scripts WHERE id=? FOR UPDATE', [found[0].script_id], db)
    const [r] = await q('SELECT * FROM reviews WHERE id=? FOR UPDATE', [id], db)
    ensure(r.status === 'pending', 409, 'REVIEW_RESOLVED', '该申请已处理或撤回')
    await q('UPDATE reviews SET status=?,reason=?,reviewer_id=?,reviewed_at=UTC_TIMESTAMP() WHERE id=?', [b.approve ? 'approved' : 'rejected', b.reason, req.user.id, id], db)
    // 发布申请提交时的冻结快照，而非作者可能已经修改的当前私有稿。
    if (b.approve) await q("UPDATE scripts SET visibility='public',review_status='approved',published_json=? WHERE id=?", [JSON.stringify(json(r.snapshot_json)), r.script_id], db)
    else await q("UPDATE scripts SET review_status='rejected' WHERE id=?", [r.script_id], db)
    await audit(req.user.id, b.approve ? 'review.approve' : 'review.reject', r.script_id, b.reason, db)
  })
  res.json({ ok: true })
})

/**
 * GET /api/admin/content
 * 用途：分页读取当前公开的作品。
 * 权限：管理员。
 * 入参：Query：page、size。
 * 返回：items、total，标题取自公开快照。
 */
adminRouter.get('/content', async (req, res) => {
  const p = paging(req.query)
  // 先对轻量 ID 排序，再读取快照标题，避免大 JSON 参与 filesort 导致排序内存不足。
  const ids = await q(`SELECT id FROM scripts WHERE visibility='public' AND deleted_at IS NULL ORDER BY updated_at DESC,id DESC LIMIT ${p.size} OFFSET ${p.offset}`)
  const rows = ids.length
    ? await q(
        `SELECT s.id,JSON_UNQUOTE(JSON_EXTRACT(s.published_json,'$.title')) title,u.nickname,s.genre FROM scripts s JOIN users u ON u.id=s.owner_id WHERE s.id IN (${ids.map(() => '?').join(',')})`,
        ids.map((r) => r.id)
      )
    : []
  const items = ids.map(({ id }) => rows.find((r) => r.id === id)).filter(Boolean)
  const [total] = await q("SELECT COUNT(*) n FROM scripts WHERE visibility='public' AND deleted_at IS NULL")
  res.json({ items, total: total.n })
})

/**
 * POST /api/admin/content/:id/takedown
 * 用途：下架作品、取消待审申请、处理相关举报并记录原因。
 * 权限：管理员。
 * 入参：Path：id；Body：reason（2～500 字符）。
 * 返回：ok，相关状态在同一事务内更新。
 */
adminRouter.post('/content/:id/takedown', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const { reason } = z.object({ reason: z.string().trim().min(2).max(500) }).parse(req.body)
  await transaction(async (db) => {
    await q("UPDATE scripts SET visibility='private',published_json=NULL,review_status='rejected' WHERE id=?", [id], db)
    await q("UPDATE reviews SET status='cancelled',reason=? WHERE script_id=? AND status='pending'", [reason, id], db)
    await q("UPDATE reports SET status='resolved' WHERE script_id=?", [id], db)
    await audit(req.user.id, 'content.takedown', id, reason, db)
  })
  res.json({ ok: true })
})

/**
 * GET /api/admin/reports
 * 用途：读取最近 100 条待处理举报。
 * 权限：管理员。
 * 入参：无。
 * 返回：举报记录及举报者昵称列表。
 */
adminRouter.get('/reports', async (req, res) => res.json(await q("SELECT r.*,u.nickname FROM reports r JOIN users u ON u.id=r.user_id WHERE r.status='pending' ORDER BY r.id DESC LIMIT 100")))

/**
 * PATCH /api/admin/reports/:id
 * 用途：将举报标记为已处理并记录审计，不直接下架剧本。
 * 权限：管理员。
 * 入参：Path：id，举报 ID。
 * 返回：ok。
 */
adminRouter.patch('/reports/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  await q("UPDATE reports SET status='resolved' WHERE id=?", [id])
  await audit(req.user.id, 'report.resolve', id)
  res.json({ ok: true })
})

/**
 * GET /api/admin/audit
 * 用途：读取最近 100 条后台操作审计。
 * 权限：管理员。
 * 入参：无。
 * 返回：操作人、动作、目标、说明及时间列表。
 */
adminRouter.get('/audit', async (req, res) =>
  // 历史个人 AI 配置记录不属于平台治理；数据库历史保留，页面只返回管理动作。
  res.json(await q("SELECT a.*,u.nickname FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE a.action IN ('user.active','user.disabled','template.create','template.update','review.approve','review.reject','content.takedown','report.resolve') ORDER BY a.id DESC LIMIT 100"))
)
