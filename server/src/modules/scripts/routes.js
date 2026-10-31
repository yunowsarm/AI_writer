/** 私有作品与编辑接口；所有版本、导出操作均校验作者归属。 */
import { Router } from 'express'
import { z } from 'zod'
import { q, transaction } from '../../db/index.js'
import { requireUser } from '../auth/service.js'
import { ensure } from '../../shared/errors.js'
import { genre, idSchema, contentSchema, paging } from '../../shared/validation.js'
import { ownedScript, ownedEpisode, mapScript, createScript, saveEpisode, addVersion, submitReview, unpublish } from './service.js'
export const scriptsRouter = Router(),
  episodesRouter = Router()
scriptsRouter.use(requireUser)
episodesRouter.use(requireUser)
const scriptSchema = z.object({
  title: z.string().trim().min(1).max(120),
  genre,
  tags: z.array(z.string().max(30)).max(10).default([]),
  synopsis: z.string().max(5000).default(''),
  outline: z.string().max(100000).default(''),
  config: z.record(z.any()).default({})
})

/**
 * GET /api/scripts
 * 用途：分页查询我的剧本，并按关键字、题材、公开或审核状态筛选。
 * 权限：已登录用户，仅本人未删除作品。
 * 入参：Query：page、size、q、genre、status。
 * 返回：items、total、page；每项含分集数与字数。
 */
scriptsRouter.get('/', async (req, res) => {
  const p = paging(req.query)
  const status = z.enum(['all', 'private', 'pending', 'public', 'rejected']).default('all').parse(req.query.status)
  let where = 's.owner_id=? AND s.deleted_at IS NULL'
  const values = [req.user.id]
  if (p.q) {
    where += ' AND (s.title LIKE ? OR s.synopsis LIKE ?)'
    values.push('%' + p.q + '%', '%' + p.q + '%')
  }
  if (p.genre) {
    where += ' AND s.genre=?'
    values.push(p.genre)
  }
  if (status === 'private') where += " AND s.visibility='private' AND s.review_status='none'"
  if (status === 'pending') where += " AND s.review_status='pending'"
  if (status === 'public') where += " AND s.visibility='public'"
  if (status === 'rejected') where += " AND s.review_status='rejected'"
  const [total] = await q('SELECT COUNT(*) count FROM scripts s WHERE ' + where, values)
  const items = await q(
    `SELECT s.*,(SELECT COUNT(*) FROM episodes e WHERE e.script_id=s.id) episode_count,(SELECT COALESCE(SUM(CHAR_LENGTH(content_text)),0) FROM episodes e WHERE e.script_id=s.id) words FROM scripts s WHERE ${where} ORDER BY s.updated_at DESC LIMIT ${p.size} OFFSET ${p.offset}`,
    values
  )
  res.json({ items: items.map(mapScript), total: total.count, page: p.page })
})

/**
 * POST /api/scripts
 * 用途：创建一部私有剧本。
 * 权限：已登录用户，作者归属由服务端指定。
 * 入参：Body：title、genre，可选 tags、synopsis、outline、config。
 * 返回：201，新剧本 id。
 */
scriptsRouter.post('/', async (req, res) => {
  const b = scriptSchema.parse(req.body)
  const id = await createScript(req.user.id, b)
  res.status(201).json({ id })
})

/**
 * GET /api/scripts/:id
 * 用途：读取我的剧本、全部分集及最近五条审核记录。
 * 权限：已登录作者。
 * 入参：Path：id，剧本 ID。
 * 返回：剧本信息、episodes、reviews。
 */
scriptsRouter.get('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const s = await ownedScript(id, req.user.id)
  const episodes = await q('SELECT * FROM episodes WHERE script_id=? ORDER BY episode_no', [id])
  const reviews = await q('SELECT id,status,reason,created_at FROM reviews WHERE script_id=? ORDER BY id DESC LIMIT 5', [id])
  res.json({ ...mapScript(s), episodes, reviews })
})

/**
 * PATCH /api/scripts/:id
 * 用途：修改剧本元信息和创作配置，不改动已公开的审核快照。
 * 权限：已登录作者。
 * 入参：Path：id；Body：title、genre、tags、synopsis、outline、config。
 * 返回：ok。
 */
scriptsRouter.patch('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = scriptSchema.parse(req.body)
  await ownedScript(id, req.user.id)
  await q('UPDATE scripts SET title=?,genre=?,tags=?,synopsis=?,outline=?,config_json=? WHERE id=?', [b.title, b.genre, JSON.stringify(b.tags), b.synopsis, b.outline, JSON.stringify(b.config), id])
  res.json({ ok: true })
})

/**
 * DELETE /api/scripts/:id
 * 用途：先撤回公开与待审核内容，再软删除剧本。
 * 权限：已登录作者。
 * 入参：Path：id。
 * 返回：ok。
 */
scriptsRouter.delete('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  await ownedScript(id, req.user.id)
  const [active] = await q("SELECT id FROM ai_jobs WHERE script_id=? AND user_id=? AND status='running' LIMIT 1", [id, req.user.id])
  ensure(!active, 409, 'SCRIPT_TASK_RUNNING', '该剧本仍有 AI 任务正在运行，请先在任务中心停止后再删除')
  await unpublish(id, req.user.id)
  await q('UPDATE scripts SET deleted_at=UTC_TIMESTAMP() WHERE id=?', [id])
  res.json({ ok: true })
})

/**
 * POST /api/scripts/:id/episodes
 * 用途：为剧本追加一个空白分集，事务内分配连续集号。
 * 权限：已登录作者，每部最多 80 集。
 * 入参：Path：id；Body：title。
 * 返回：201，新分集 id。
 */
scriptsRouter.post('/:id/episodes', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = z.object({ title: z.string().trim().min(1).max(120) }).parse(req.body)
  const result = await transaction(async (db) => {
    // 锁定同一作品后再计算 MAX 集号，避免并发新增分集分配到重复集号。
    await q('SELECT id FROM scripts WHERE id=? FOR UPDATE', [id], db)
    await ownedScript(id, req.user.id, db)
    const running = await q("SELECT id FROM ai_jobs WHERE script_id=? AND status='running' AND operation IN ('generate','append-episode')", [id], db)
    ensure(!running.length, 409, 'SCRIPT_TASK_RUNNING', '剧本正在生成分集，请先等待或停止任务')
    const [last] = await q('SELECT COALESCE(MAX(episode_no),0) n FROM episodes WHERE script_id=?', [id], db)
    ensure(last.n < 80, 400, 'EPISODE_LIMIT', '每部剧本最多 80 集')
    return q('INSERT INTO episodes(script_id,episode_no,title,content_html,content_text) VALUES(?,?,?,?,?)', [id, last.n + 1, b.title, '<p></p>', ''], db)
  })
  res.status(201).json({ id: result.insertId })
})

/**
 * POST /api/scripts/:id/publish
 * 用途：冻结当前剧本内容并提交公开审核。
 * 权限：已登录作者；正文不能为空且不能重复提交待审申请。
 * 入参：Path：id。
 * 返回：reviewId，审核申请 ID。
 */
scriptsRouter.post('/:id/publish', async (req, res) => res.json({ reviewId: await submitReview(idSchema.parse(req.params.id), req.user.id) }))

/**
 * POST /api/scripts/:id/unpublish
 * 用途：撤销公开快照，并取消尚未处理的审核申请。
 * 权限：已登录作者。
 * 入参：Path：id。
 * 返回：ok。
 */
scriptsRouter.post('/:id/unpublish', async (req, res) => {
  await unpublish(idSchema.parse(req.params.id), req.user.id)
  res.json({ ok: true })
})

/**
 * GET /api/scripts/:id/export
 * 用途：按集号顺序导出整部剧本的纯文本内容。
 * 权限：已登录作者。
 * 入参：Path：id；Query：type=txt 或 md。
 * 返回：UTF-8 文本附件，文件名使用剧本标题。
 */
scriptsRouter.get('/:id/export', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const type = z.enum(['txt', 'md']).parse(req.query.type)
  const s = await ownedScript(id, req.user.id)
  const episodes = await q('SELECT title,content_text FROM episodes WHERE script_id=? ORDER BY episode_no', [id])
  const text = (type === 'md' ? '# ' : '') + s.title + '\n\n' + episodes.map((e) => (type === 'md' ? '## ' : '') + e.title + '\n\n' + e.content_text).join('\n\n')
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(s.title)}.${type}`)
  res.send(text)
})

/**
 * PATCH /api/episodes/:id
 * 用途：保存分集正文并生成历史快照，使用 revision 防止并发覆盖。
 * 权限：已登录作者。
 * 入参：Path：id；Body：title、html、text、revision，可选 document、reason。
 * 返回：更新后的分集，包含递增后的 revision；冲突返回 409。
 */
episodesRouter.patch('/:id', async (req, res) => res.json(await saveEpisode(idSchema.parse(req.params.id), req.user.id, contentSchema.parse(req.body))))

/** DELETE /api/episodes/:id：作者删除指定分集及其版本，后续集号顺次前移；运行中或版本冲突时不删除。 */
episodesRouter.delete('/:id', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const { revision } = z.object({ revision: z.number().int().positive() }).parse(req.body)
  const original = await ownedEpisode(id, req.user.id)
  await transaction(async (db) => {
    await q('SELECT id FROM scripts WHERE id=? FOR UPDATE', [original.script_id], db)
    await ownedScript(original.script_id, req.user.id, db)
    const running = await q("SELECT id FROM ai_jobs WHERE script_id=? AND status='running' AND operation IN ('generate','append-episode')", [original.script_id], db)
    ensure(!running.length, 409, 'SCRIPT_TASK_RUNNING', '剧本正在生成分集，请先等待或停止任务')
    const [episode] = await q('SELECT * FROM episodes WHERE id=? FOR UPDATE', [id], db)
    ensure(episode, 404, 'EPISODE_NOT_FOUND', '分集已删除')
    ensure(episode.revision === revision, 409, 'REVISION_CONFLICT', '分集已有更新，请刷新后重新确认删除')
    await q('DELETE FROM episodes WHERE id=?', [id], db)
    const following = await q('SELECT id,episode_no FROM episodes WHERE script_id=? AND episode_no>? ORDER BY episode_no', [original.script_id, episode.episode_no], db)
    for (const next of following) await q('UPDATE episodes SET episode_no=episode_no-1 WHERE id=?', [next.id], db)
    await q('UPDATE scripts SET updated_at=UTC_TIMESTAMP() WHERE id=?', [original.script_id], db)
  })
  res.json({ ok: true })
})

/**
 * GET /api/episodes/:id/versions
 * 用途：获取分集最近 100 个历史版本的摘要。
 * 权限：已登录作者。
 * 入参：Path：id，分集 ID。
 * 返回：版本 id、revision、保存原因、字数和时间列表。
 */
episodesRouter.get('/:id/versions', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  await ownedEpisode(id, req.user.id)
  res.json(await q('SELECT id,revision,reason,CHAR_LENGTH(content_text) words,created_at FROM versions WHERE episode_id=? ORDER BY id DESC LIMIT 100', [id]))
})

/**
 * GET /api/episodes/:id/versions/:versionId
 * 用途：读取指定分集的某个历史版本正文。
 * 权限：已登录作者，版本必须属于该分集。
 * 入参：Path：id、versionId。
 * 返回：完整版本记录。
 */
episodesRouter.get('/:id/versions/:versionId', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  await ownedEpisode(id, req.user.id)
  const rows = await q('SELECT * FROM versions WHERE id=? AND episode_id=?', [idSchema.parse(req.params.versionId), id])
  ensure(rows.length, 404, 'VERSION_NOT_FOUND', '版本不存在')
  res.json(rows[0])
})

/**
 * POST /api/episodes/:id/restore
 * 用途：备份当前内容，再将指定历史内容保存为新的当前版本。
 * 权限：已登录作者，仍校验当前 revision。
 * 入参：Path：id；Body：versionId、revision。
 * 返回：恢复后的分集及新 revision；历史记录保留。
 */
episodesRouter.post('/:id/restore', async (req, res) => {
  const id = idSchema.parse(req.params.id)
  const b = z.object({ versionId: idSchema, revision: z.number().int().positive() }).parse(req.body)
  await ownedEpisode(id, req.user.id)
  const rows = await q('SELECT * FROM versions WHERE id=? AND episode_id=?', [b.versionId, id])
  ensure(rows.length, 404, 'VERSION_NOT_FOUND', '版本不存在')
  const v = rows[0]
  const e = await ownedEpisode(id, req.user.id)
  await addVersion(e, '回退前备份')
  res.json(
    await saveEpisode(id, req.user.id, {
      title: e.title,
      revision: b.revision,
      document: v.document_json,
      html: v.content_html,
      text: v.content_text,
      reason: '回退到版本 ' + b.versionId
    })
  )
})
