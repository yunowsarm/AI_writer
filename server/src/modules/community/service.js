/** 公开读取边界：只投影审核通过的快照，不返回作者正在编辑的私有稿。 */
import { q, json } from '../../db/index.js'
import { ensure } from '../../shared/errors.js'
export const publicWhere =
  "s.visibility='public' AND s.published_json IS NOT NULL AND s.deleted_at IS NULL AND u.status='active'"

/**
 * 仅从已审核的 published_json 提取公开摘要，并附加查询得到的互动统计。
 */
export function publicSummary(row) {
  const s = json(row.published_json)
  return {
    id: row.id,
    title: s.title,
    genre: s.genre,
    tags: s.tags,
    synopsis: s.synopsis,
    episode_count: s.episodes.length,
    author: row.nickname,
    authorId: row.owner_id,
    likes: Number(row.like_count || 0),
    views: Number(row.views || 0),
    comments: Number(row.comment_count || 0),
    liked: !!row.liked,
    favorited: !!row.favorited,
    updated_at: row.updated_at,
  }
}

/**
 * 读取仍公开且作者账号启用的剧本，统一拒绝未公开、撤回或下架内容。
 */
export async function publicScript(id) {
  const rows = await q(
    `SELECT s.*,u.nickname FROM scripts s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND ${publicWhere}`,
    [id]
  )
  ensure(rows.length, 404, 'PUBLIC_NOT_FOUND', '该作品未公开、已撤回或已下架')
  return rows[0]
}
