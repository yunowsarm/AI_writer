/** 分集续写：冻结已有正文及剧情走向，后台生成完整新集，确认上下文未变后一次性落库。 */
import { z } from 'zod'
import { q, transaction, json } from '../../db/index.js'
import { idSchema } from '../../shared/validation.js'
import { selectionSchema } from '../settings/providers.js'
import { ownedScript, addVersion } from '../scripts/service.js'
import { trackedCompletion } from '../usage/service.js'
import { textToHtml } from '../../shared/content.js'
import { ensure } from '../../shared/errors.js'
import { finishFailedJob } from './failure.js'

/** POST /api/ai/scripts/:id/episodes：按本人模型和剧情走向追加一集；返回202任务，退出页面后继续生成。 */
export async function appendEpisode(req, res, startJob) {
  const scriptId = idSchema.parse(req.params.id)
  const body = z.object({ title: z.string().trim().min(1).max(120), direction: z.string().trim().min(2).max(3000), selection: selectionSchema.optional() }).parse(req.body)
  const script = await ownedScript(scriptId, req.user.id)
  const episodes = await q('SELECT id,episode_no,title,revision,content_text FROM episodes WHERE script_id=? ORDER BY episode_no', [scriptId])
  const number = (episodes.at(-1)?.episode_no || 0) + 1
  ensure(number <= 80, 400, 'EPISODE_LIMIT', '每部剧本最多80集')
  const job = await startJob(req, res, 'append-episode', { ...body, title: script.title + ' · ' + body.title, background: true }, scriptId)
  try {
    job.send('phase', { scriptId, message: '正在按剧情走向续写第 ' + number + ' 集', completed: 0, total: 1 })
    const content = await trackedCompletion(
      job,
      [
        {
          role: 'system',
          content: '你是中文短剧编剧。延续既有角色、事实和伏笔，按用户指定剧情走向创作完整的新分集。用【场景】【人物】【动作旁白】及“角色：台词”格式，只输出本集正文，不重复已有剧本，不解释。'
        },
        {
          role: 'user',
          content: JSON.stringify({
            title: script.title,
            genre: script.genre,
            config: json(script.config_json),
            synopsis: script.synopsis,
            outline: script.outline.slice(0, 16000),
            previousEpisodes: episodes.slice(-3).map((e) => ({ title: e.title, text: e.content_text.slice(-8000) })),
            episodeNo: number,
            episodeTitle: body.title,
            direction: body.direction
          })
        }
      ],
      { phase: 'episode', episodeNo: number, signal: job.controller.signal }
    )
    job.controller.signal.throwIfAborted()
    const id = await transaction(async (db) => {
      await q('SELECT id FROM scripts WHERE id=? FOR UPDATE', [scriptId], db)
      const latest = await ownedScript(scriptId, req.user.id, db)
      const current = await q('SELECT id,revision FROM episodes WHERE script_id=? ORDER BY episode_no FOR UPDATE', [scriptId], db)
      ensure(
        JSON.stringify(current) === JSON.stringify(episodes.map(({ id, revision }) => ({ id, revision }))) &&
          ['title', 'genre', 'synopsis', 'outline'].every((key) => latest[key] === script[key]) &&
          JSON.stringify(json(latest.config_json)) === JSON.stringify(json(script.config_json)),
        409,
        'EPISODE_CONTEXT_CHANGED',
        '生成期间原剧本已修改，本次未追加分集，请基于最新内容重试'
      )
      const row = await q('INSERT INTO episodes(script_id,episode_no,title,content_html,content_text) VALUES(?,?,?,?,?)', [scriptId, number, body.title, textToHtml(content), content], db)
      await addVersion({ id: row.insertId, content_html: textToHtml(content), content_text: content, document_json: null, revision: 1 }, 'AI 剧情续写', db)
      await q('UPDATE scripts SET updated_at=UTC_TIMESTAMP() WHERE id=?', [scriptId], db)
      return row.insertId
    })
    await q("UPDATE ai_jobs SET status='completed',output=? WHERE id=?", [JSON.stringify({ episodeId: id }), job.id])
    job.send('done', { scriptId, episodeId: id, message: '新分集已生成并保存' })
  } catch (e) {
    await finishFailedJob(job, e, { scriptId })
  } finally {
    await job.finish()
  }
}
