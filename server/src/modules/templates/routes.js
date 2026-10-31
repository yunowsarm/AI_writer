/** 模板与参数配置：官方模板受管理员管理，个人模板始终校验所有权。 */
import { Router } from 'express'
import { z } from 'zod'
import { q, json } from '../../db/index.js'
import { requireUser } from '../auth/service.js'
import { ensure } from '../../shared/errors.js'
import { paramsSchema, idSchema, genre, paging } from '../../shared/validation.js'
export const templatesRouter = Router(),
  configsRouter = Router()
templatesRouter.use(requireUser)
configsRouter.use(requireUser)
export const templateSchema = z.object({
  title: z.string().trim().min(1).max(120),
  genre,
  description: z.string().max(5000),
  params: paramsSchema,
  outline: z.string().max(100000).default('')
})

/**
 * 将模板 params JSON 转换为接口可使用的对象。
 */
export const mapTemplate = (t) => ({ ...t, params: json(t.params), favorited: !!t.favorited })

/**
 * 读取已上架的官方模板或指定用户的个人模板，否则统一返回 404。
 */
export async function visibleTemplate(id, userId) {
  const rows = await q(
    "SELECT t.*,EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=? AND f.target_type='template' AND f.target_id=t.id) favorited FROM templates t WHERE t.id=? AND t.status='active' AND (t.kind='official' OR t.visibility='public' OR t.owner_id=?)",
    [userId, id, userId]
  )
  ensure(rows.length, 404, 'TEMPLATE_NOT_FOUND', '模板不存在、已下架或无权访问')
  return mapTemplate(rows[0])
}

/**
 * GET /api/templates
 * 用途：分页读取可用的官方模板和本人个人模板。
 * 权限：已登录用户。
 * 入参：Query：page、size、q、genre、sort、kind（all/official/personal）。
 * 返回：items、total，模板 params 已解析为对象。
 */
templatesRouter.get('/', async (req, res) => {
  const p = paging(req.query)
  const kind = z.enum(['all', 'official', 'personal', 'public']).default('all').parse(req.query.kind)
  const where =
    "status='active' AND (kind='official' OR visibility='public' OR owner_id=?) AND (?='' OR genre=?) AND (?='' OR title LIKE ? OR description LIKE ?) AND (?='all' OR (?='personal' AND kind='personal' AND owner_id=?) OR (?='official' AND kind='official') OR (?='public' AND kind='personal' AND visibility='public'))"
  const values = [req.user.id, p.genre, p.genre, p.q, '%' + p.q + '%', '%' + p.q + '%', kind, kind, req.user.id, kind, kind]
  const [total] = await q('SELECT COUNT(*) count FROM templates WHERE ' + where, values)
  const items = await q(
    `SELECT t.*,EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=? AND f.target_type='template' AND f.target_id=t.id) favorited FROM templates t WHERE ${where} ORDER BY ${p.sort === 'hot' ? 'uses DESC,' : ''}id DESC LIMIT ${p.size} OFFSET ${p.offset}`,
    [req.user.id, ...values]
  )
  res.json({ items: items.map(mapTemplate), total: total.count })
})

/**
 * GET /api/templates/:id
 * 用途：预览可用模板详情。
 * 权限：已登录用户，仅官方或本人个人模板。
 * 入参：Path：id。
 * 返回：模板详情。
 */
templatesRouter.get('/:id', async (req, res) => res.json(await visibleTemplate(idSchema.parse(req.params.id), req.user.id)))

/**
 * POST /api/templates
 * 用途：创建个人模板。
 * 权限：已登录用户，不能通过本接口创建官方模板。
 * 入参：Body：title、genre、description、params，可选 outline。
 * 返回：201，新模板 id。
 */
templatesRouter.post('/', async (req, res) => {
  const b = templateSchema.parse(req.body)
  const result = await q('INSERT INTO templates(owner_id,kind,title,genre,description,params,outline) VALUES(?,?,?,?,?,?,?)', [
    req.user.id,
    'personal',
    b.title,
    b.genre,
    b.description,
    JSON.stringify(b.params),
    b.outline
  ])
  res.status(201).json({ id: result.insertId })
})

/**
 * PATCH /api/templates/:id
 * 用途：修改本人个人模板。
 * 权限：已登录模板所有者，仅 personal 类型。
 * 入参：Path：id；Body：title、genre、description、params、outline。
 * 返回：ok。
 */
templatesRouter.patch('/:id', async (req, res) => {
  const b = templateSchema.parse(req.body)
  const result = await q("UPDATE templates SET title=?,genre=?,description=?,params=?,outline=? WHERE id=? AND owner_id=? AND kind='personal'", [
    b.title,
    b.genre,
    b.description,
    JSON.stringify(b.params),
    b.outline,
    idSchema.parse(req.params.id),
    req.user.id
  ])
  ensure(result.affectedRows, 404, 'TEMPLATE_NOT_FOUND', '个人模板不存在')
  res.json({ ok: true })
})

/**
 * DELETE /api/templates/:id
 * 用途：下架本人个人模板，保留原记录。
 * 权限：已登录模板所有者。
 * 入参：Path：id。
 * 返回：ok。
 */
templatesRouter.delete('/:id', async (req, res) => {
  const result = await q("UPDATE templates SET status='offline' WHERE id=? AND owner_id=? AND kind='personal'", [idSchema.parse(req.params.id), req.user.id])
  ensure(result.affectedRows, 404, 'TEMPLATE_NOT_FOUND', '个人模板不存在')
  res.json({ ok: true })
})

/**
 * POST /api/templates/:id/apply
 * 用途：读取模板创作参数，并增加套用次数。
 * 权限：已登录用户，仅可访问的有效模板。
 * 入参：Path：id。
 * 返回：params、outline，供创作页面填充。
 */
templatesRouter.post('/:id/apply', async (req, res) => {
  const t = await visibleTemplate(idSchema.parse(req.params.id), req.user.id)
  await q('UPDATE templates SET uses=uses+1 WHERE id=?', [t.id])
  res.json({ params: t.params, outline: t.outline })
})

/**
 * GET /api/generation-configs
 * 用途：获取当前用户最近保存的 100 份生成参数。
 * 权限：已登录用户，仅本人配置。
 * 入参：无。
 * 返回：配置列表，params 已解析为对象。
 */
configsRouter.get('/', async (req, res) =>
  res.json((await q('SELECT * FROM generation_configs WHERE user_id=? ORDER BY id DESC LIMIT 100', [req.user.id])).map((c) => ({ ...c, params: json(c.params) })))
)

/**
 * POST /api/generation-configs
 * 用途：保存可复用的剧本生成参数。
 * 权限：已登录用户。
 * 入参：Body：name、params，params 遵循创作参数约束。
 * 返回：201，新配置 id。
 */
configsRouter.post('/', async (req, res) => {
  const b = z.object({ name: z.string().trim().min(1).max(80), params: paramsSchema }).parse(req.body)
  const result = await q('INSERT INTO generation_configs(user_id,name,params) VALUES(?,?,?)', [req.user.id, b.name, JSON.stringify(b.params)])
  res.status(201).json({ id: result.insertId })
})

/**
 * DELETE /api/generation-configs/:id
 * 用途：删除当前用户保存的一份生成配置。
 * 权限：已登录用户，仅本人配置。
 * 入参：Path：id。
 * 返回：ok，重复删除也返回成功。
 */
configsRouter.delete('/:id', async (req, res) => {
  await q('DELETE FROM generation_configs WHERE id=? AND user_id=?', [idSchema.parse(req.params.id), req.user.id])
  res.json({ ok: true })
})

/** PATCH /api/templates/:id/visibility：仅作者可以公开或撤回个人模板。 */
templatesRouter.patch('/:id/visibility', async (req, res) => {
  const { visibility } = z.object({ visibility: z.enum(['private', 'public']) }).parse(req.body)
  const result = await q("UPDATE templates SET visibility=? WHERE id=? AND owner_id=? AND kind='personal' AND status='active'", [visibility, idSchema.parse(req.params.id), req.user.id])
  ensure(result.affectedRows, 404, 'TEMPLATE_NOT_FOUND', '模板不存在或无权操作')
  res.json({ ok: true, visibility })
})
