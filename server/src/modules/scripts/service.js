/** 剧本服务：作者权限、乐观锁保存、不可变快照和公开审核边界。 */
import { q, transaction, json } from '../../db/index.js'
import { ensure } from '../../shared/errors.js'
import { cleanContent } from '../../shared/content.js'

/**
 * 解析剧本标签与生成配置，隐藏内部 JSON 字段和公开快照字段。
 */
export function mapScript(s) {
  return {
    ...s,
    tags: json(s.tags),
    config: json(s.config_json),
    published_json: undefined,
    config_json: undefined
  }
}

/**
 * 读取指定作者未删除的剧本；不存在或无权限时统一返回 404。
 */
export async function ownedScript(id, userId, db) {
  const rows = await q('SELECT * FROM scripts WHERE id=? AND owner_id=? AND deleted_at IS NULL', [id, userId], db)
  ensure(rows.length, 404, 'SCRIPT_NOT_FOUND', '剧本不存在或无权访问')
  return rows[0]
}

/**
 * 经所属剧本检查作者归属和软删除状态后，读取分集正文。
 */
export async function ownedEpisode(id, userId, db) {
  const rows = await q('SELECT e.* FROM episodes e JOIN scripts s ON s.id=e.script_id WHERE e.id=? AND s.owner_id=? AND s.deleted_at IS NULL', [id, userId], db)
  ensure(rows.length, 404, 'EPISODE_NOT_FOUND', '分集不存在或无权访问')
  return rows[0]
}

/**
 * 将当前分集正文、文档、revision 和原因写入独立历史快照。
 * 传入 db 时与调用方的正文写入共用事务，不覆盖已有版本。
 */
export async function addVersion(e, reason, db) {
  await q(
    'INSERT INTO versions(episode_id,document_json,content_html,content_text,revision,reason) VALUES(?,?,?,?,?,?)',
    [e.id, e.document_json ? JSON.stringify(json(e.document_json)) : null, e.content_html, e.content_text, e.revision, reason],
    db
  )
}

/**
 * 为指定用户创建私有剧本并返回 ID；可复用调用方事务连接。
 */
export async function createScript(userId, b, db) {
  const result = await q(
    'INSERT INTO scripts(owner_id,title,genre,tags,synopsis,config_json,outline) VALUES(?,?,?,?,?,?,?)',
    [userId, b.title, b.genre, JSON.stringify(b.tags || []), b.synopsis || '', JSON.stringify(b.config || {}), b.outline || ''],
    db
  )
  return result.insertId
}

/**
 * 清洗富文本并以乐观锁保存分集，生成新历史快照。
 * UPDATE 同时匹配 id 与客户端 revision；冲突返回 409，正文、快照和剧本更新时间一起回滚。
 */
export async function saveEpisode(id, userId, b) {
  const content = cleanContent(b)
  return transaction(async (db) => {
    const e = await ownedEpisode(id, userId, db)
    const result = await q(
      'UPDATE episodes SET title=?,document_json=?,content_html=?,content_text=?,revision=revision+1 WHERE id=? AND revision=?',
      [b.title, content.document ? JSON.stringify(content.document) : null, content.html, content.text, id, b.revision],
      db
    )
    ensure(result.affectedRows, 409, 'REVISION_CONFLICT', '该分集已被更新，请重新载入后合并修改')
    const updated = {
      ...e,
      title: b.title,
      document_json: content.document,
      content_html: content.html,
      content_text: content.text,
      revision: b.revision + 1
    }
    await addVersion(updated, b.reason, db)
    await q('UPDATE scripts SET updated_at=CURRENT_TIMESTAMP(3) WHERE id=?', [e.script_id], db)
    return updated
  })
}

/**
 * 组装用于公开审核的独立剧本快照，包括元信息和按集号排序的正文。
 * 拒绝没有任何非空正文的作品；后续编辑私有稿不会改变此快照。
 */
export async function snapshotScript(id, userId, db) {
  const s = await ownedScript(id, userId, db)
  const episodes = await q('SELECT id,episode_no,title,content_html,content_text,revision FROM episodes WHERE script_id=? ORDER BY episode_no', [id], db)
  ensure(episodes.length && episodes.some((e) => e.content_text.trim()), 400, 'EMPTY_SCRIPT', '请先写入剧本内容再提交公开')
  return {
    id: s.id,
    title: s.title,
    genre: s.genre,
    tags: json(s.tags),
    synopsis: s.synopsis,
    outline: s.outline,
    episodes
  }
}

/**
 * 锁定剧本后冻结内容并创建待审核申请。
 * 在同一事务检查重复待审、插入快照及更新审核状态，防止并发重复提交。
 */
export async function submitReview(id, userId) {
  return transaction(async (db) => {
    await q('SELECT id FROM scripts WHERE id=? FOR UPDATE', [id], db)
    const snapshot = await snapshotScript(id, userId, db)
    const current = await ownedScript(id, userId, db)
    ensure(current.visibility !== 'public', 409, 'SCRIPT_ALREADY_PUBLIC', '该剧本已公开；如需发布修改后的版本，请先设为私有，再重新提交审核')
    const pending = await q("SELECT id FROM reviews WHERE script_id=? AND status='pending'", [id], db)
    ensure(!pending.length, 409, 'REVIEW_PENDING', '已有待审核版本，请等待或撤回')
    const result = await q('INSERT INTO reviews(script_id,submitted_by,snapshot_json) VALUES(?,?,?)', [id, userId, JSON.stringify(snapshot)], db)
    await q("UPDATE scripts SET review_status='pending' WHERE id=?", [id], db)
    return result.insertId
  })
}

/**
 * 撤回作品的公开快照，同时取消尚未处理的审核申请。
 * 先验证作者身份，再在同一事务更新作品和审核记录。
 */
export async function unpublish(id, userId) {
  await transaction(async (db) => {
    await ownedScript(id, userId, db)
    await q("UPDATE scripts SET visibility='private',published_json=NULL,review_status='none' WHERE id=?", [id], db)
    await q("UPDATE reviews SET status='cancelled' WHERE script_id=? AND status='pending'", [id], db)
  })
}
