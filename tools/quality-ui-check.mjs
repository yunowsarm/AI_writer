/** 隔离的 UI 验收服务：仅使用 mujian_test 和本地模拟模型，通过停止接口清理本次记录。 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DB_NAME = 'mujian_test'
const temporary = await mkdtemp(join(tmpdir(), 'quality-ui-'))
process.env.AI_KEY_FILE = join(temporary, 'master.key')
const { config } = await import('../server/src/config.js')
const { q, pool } = await import('../server/src/db/index.js')
const { migrate } = await import('../server/scripts/migrate.js')
const { createApp } = await import('../server/src/app.js')
const { createSession } = await import('../server/src/modules/auth/service.js')
const { saveAiSettings } = await import('../server/src/modules/settings/service.js')
const { createScript, addVersion } = await import('../server/src/modules/scripts/service.js')
const { textToHtml } = await import('../server/src/shared/content.js')
const [[database]] = await pool.query('SELECT DATABASE() name')
if (database.name !== 'mujian_test') throw new Error('只能使用独立测试库')
await migrate()
// 异常终止后的定向清理仅接受明确脚本 ID，并再次检查测试库与样例归属。
const cleanupId = Number(process.argv.find((arg) => arg.startsWith('--cleanup-script='))?.split('=')[1])
if (cleanupId) {
  const [row] = await q(
    "SELECT s.owner_id FROM scripts s JOIN users u ON u.id=s.owner_id WHERE s.id=? AND s.title='验收样例：被替换的原始设计' AND u.nickname='质量功能验收' AND u.email LIKE '%@test.invalid'",
    [cleanupId]
  )
  if (!row) throw new Error('不是本次验收样例，拒绝清理')
  await q('DELETE FROM ai_jobs WHERE user_id=?', [row.owner_id])
  await q('DELETE FROM scripts WHERE id=? AND owner_id=?', [cleanupId, row.owner_id])
  await q('DELETE FROM users WHERE id=?', [row.owner_id])
  await pool.end()
  await rm(temporary, { recursive: true, force: true })
  process.exit(0)
}
const user = await q('INSERT INTO users(email,nickname) VALUES(?,?)', [randomUUID() + '@test.invalid', '质量功能验收'])
const userId = user.insertId
if (process.env.QA_ADMIN === '1') await q("UPDATE users SET role='admin' WHERE id=?", [userId])
const fixture = {
  scores: { character: 76, plot: 79, rhythm: 84, dialogue: 86 },
  summary: '林夏在项目会议上发现证据，追查被替换的原始设计。',
  facts: [],
  events: ['发现原始设计被替换'],
  rhythm: { conflict: 82, reversal: 75, suspense: 90 },
  issues: []
}
const upstream = http
  .createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    let content = '林夏：先核对文件的版本记录，再判断是谁替换了原始设计。'
    if (body.messages?.[1]?.content?.includes('创意随机标识')) content = JSON.stringify({ title: '雨夜的第七封信', params: { theme: '一位邮递员追查七封无人认领的信，发现小城旧案的关键证人。', people: '林晓：邮递员，寻找失踪的姐姐；周远：档案员，守护一段不能说的过去。', background: '当代沿海小城，台风来临前的七个雨夜。', style: '悬疑', styleNote: '现实主义悬疑，节奏紧凑，带有轻微黑色幽默。', episodes: 5, duration: 2, twist: '每封信都推翻一个结论，最终揭示寄信人正是失踪的姐姐。' } })
    let taskInput
    try {
      taskInput = JSON.parse(body.messages?.[1]?.content)
    } catch {
      /* 常规创作请求为普通文本。 */
    }
    if (taskInput?.task === 'revise-script-passage') {
      content = taskInput.passage + ' 请当场展示原始材料并核对。'
      if (process.env.QA_REVIEW_STATES === '1' && taskInput.passage.startsWith('【动作旁白】')) content = '突然出现一个完全无关的新角色，所有文件都消失了。'
    }
    if (taskInput?.task === 'compare-script-versions')
      content = JSON.stringify({
        comparisons: taskInput.pairs.map((p) => ({
          changeId: p.changeId,
          issueAudit: {
            checks: [...new Set(p.concerns.map((i) => i.id))].map((issueId) => {
              const candidate = p.versions.A.includes('请当场展示原始材料') ? 'A' : 'B',
                source = candidate === 'A' ? 'B' : 'A'
              return { issueId, [source]: 'present', [candidate]: 'absent', ['quote' + source]: p.versions[source].slice(0, 120), ['quote' + candidate]: '' }
            }),
            introduced: []
          },
          winner: process.env.QA_REVIEW_STATES === '1' && !p.changeId.startsWith('episode-') && p.versions.A.startsWith('陈经理：') ? 'B' : p.versions.A.includes('请当场展示原始材料') ? 'A' : 'B',
          confidence: 0.95,
          resolved: true,
          reason: '核对动作更具体，角色与事实保持一致',
          regressions: []
        }))
      })
    if (body.messages?.[1]?.content.includes('待处理内容：陈经理')) content = '陈经理：先核对提交时间，未经确认的文件不能作数。'
    if (body.messages[0].content.includes('短剧编辑和剧本一致性评审员')) {
      const input = JSON.parse(body.messages[1].content)
      if (input.paragraphs) {
        const evidence = input.paragraphs.find((p) => p.text.startsWith('林夏：')) || input.paragraphs[0]
        const secondEvidence = input.paragraphs.find((p) => p.text.startsWith('陈经理：')) || input.paragraphs.at(-1)
        content = JSON.stringify({
          ...fixture,
          issues: [
            {
              dimension: 'plot',
              title: '关键证据的来源交代不足',
              explanation: '角色直接拿出决定性证据，缺少取得证据的过程。',
              suggestion: '补充发现设计版本记录的动作，让证据来源与反击形成因果。',
              severity: 'major',
              confidence: 0.86,
              evidence: [{ paragraphId: evidence.paragraphId, quote: evidence.text }]
            },
            {
              dimension: 'dialogue',
              title: '对手的台词目标可以更明确',
              explanation: '质疑台词缺少明确阻碍。',
              suggestion: '补充对手试图拖延核查的意图。',
              severity: 'minor',
              confidence: 0.8,
              evidence: [{ paragraphId: secondEvidence.paragraphId, quote: secondEvidence.text }]
            }
          ]
        })
        if (process.env.QA_REVIEW_STATES === '1') {
          const value = JSON.parse(content)
          const action = input.paragraphs.find((p) => p.text.startsWith('【动作旁白】'))
          if (action)
            value.issues.push({
              dimension: 'plot',
              title: '动作与证据来源衔接不足',
              explanation: '需要交代文件来源',
              suggestion: '只补充必要的调取动作',
              severity: 'major',
              confidence: 0.9,
              evidence: [{ paragraphId: action.paragraphId, quote: action.text }]
            })
          content = JSON.stringify(value)
        }
      } else content = JSON.stringify({ summary: '未发现明确的身份冲突，可补充事件过渡。', issues: [] })
    }
    const delay = Number(process.env.QA_DELAY_MS || 0)
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    // 流式滚动验收：仅正文请求分批发送长文本，供人工上翻、跟随和抽屉定位检查。
    if (process.env.QA_STREAM === '1' && body.messages?.[1]?.content?.includes('集完整正文')) {
      content = Array.from({ length: 160 }, (_, i) => `【动作旁白】第${i + 1}段，林夏核对项目的版本记录，众人等待新的线索。\n`).join('')
      for (let offset = 0; offset < content.length && !res.destroyed; offset += 45) {
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: content.slice(offset, offset + 45) } }] }) + '\n\n')
        await new Promise((resolve) => setTimeout(resolve, 140))
      }
      content = ''
    }
    res.end(
      'data: ' +
        JSON.stringify({ choices: [{ delta: { content } }] }) +
        '\n\ndata: ' +
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 60, total_tokens: 160 } }) +
        '\n\ndata: [DONE]\n\n'
    )
  })
  .listen(0, '127.0.0.1')
await new Promise((resolve) => upstream.once('listening', resolve))
config.ai.baseUrl = 'http://127.0.0.1:' + upstream.address().port
config.origin = 'http://127.0.0.1:5191'
await saveAiSettings(userId, { model: 'ui-test-model', timeout: process.env.QA_STREAM === '1' ? 60000 : 10000, apiKey: 'local-fixture-only' })
const scriptId = await createScript(userId, {
  title: '验收样例：被替换的原始设计',
  genre: '逆袭',
  synopsis: 'UI 验收专用样例',
  config: { theme: '找回原始设计', people: '林夏，设计师', style: '逆袭', episodes: process.env.QA_CREATION === '1' ? 3 : 2, duration: 1, background: '设计公司', twist: '逐集揭示证据' }
})
for (const episodeNo of [1, 2]) {
  let text =
    '【场景】设计公司会议室 · 日 · 内\n【人物】林夏、陈经理\n【动作旁白】林夏打开电脑，调出一份项目文件。\n林夏：这份设计来自我最早提交的版本，版本记录里有完整的修改时间和署名。\n陈经理：你凭什么说这是真的？\n【动作旁白】投影亮起，所有人看向屏幕。'
  if (process.env.QA_DUPLICATES === '1') text = text.replace('\n陈经理：', '\n林夏：这份设计来自我最早提交的版本，版本记录里有完整的修改时间和署名。\n陈经理：')
  if (process.env.QA_LONG_DOC === '1')
    text = text.replace('\n林夏：', '\n' + '【动作旁白】众人仔细检查会议资料，等待版本记录加载。\n'.repeat(25) + '林夏：') + '\n' + '【动作旁白】会议结束后，众人整理桌上的项目材料。\n'.repeat(50)
  const row = await q('INSERT INTO episodes(script_id,episode_no,title,content_html,content_text) VALUES(?,?,?,?,?)', [scriptId, episodeNo, '第 ' + episodeNo + ' 集', textToHtml(text), text])
  await addVersion({ id: row.insertId, content_html: textToHtml(text), content_text: text, revision: 1 }, '验收样例')
}
let cookie
if (process.env.QA_ADMIN === '1') await q("UPDATE scripts SET visibility='public',published_json=? WHERE id=?", [JSON.stringify({ title: '管理列表验收：被替换的原始设计', episodes: [] }), scriptId])
await createSession(userId, {
  cookie: (name, token) => {
    cookie = name + '=' + token
  }
})
const app = createApp()
const server = http
  .createServer((req, res) => {
    if (req.url === '/__quality_check_stop' && req.method === 'POST') {
      res.end('验收结束')
      setImmediate(() => cleanup().then(() => process.exit(0)))
      return
    }
    if (req.url === '/__quality_check') {
      res.setHeader('Set-Cookie', 'mujian_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax')
      res.writeHead(302, { Location: '/scripts/' + scriptId }).end()
      return
    }
    // 验收服务器固定使用隔离样例会话，不覆盖主站 /api 路径的登录 Cookie。
    if (process.env.QA_DEMO_LOGIN !== '1') {
      req.headers.cookie = cookie
      delete req.headers['x-window-session']
    }
    app(req, res)
  })
  .listen(5191, '127.0.0.1')
await new Promise((resolve) => server.once('listening', resolve))
const response = await fetch(config.origin + '/api/quality/scripts/' + scriptId + '/evaluate', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' })
const stream = await response.text()
if (!stream.includes('event: done')) throw new Error('评估验收准备失败')
console.log('隔离验收页面：http://127.0.0.1:5191/__quality_check（本地模拟模型）')
console.log('通过 POST /__quality_check_stop 清理本次测试用户、剧本和报告并退出。')

/** 清理严格限定本次随机用户，不清空表、不改业务库。 */
async function cleanup() {
  server.closeAllConnections()
  upstream.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await new Promise((resolve) => upstream.close(resolve))
  await q('DELETE FROM ai_jobs WHERE user_id=?', [userId])
  await q('DELETE FROM scripts WHERE owner_id=?', [userId])
  await q('DELETE FROM users WHERE id=?', [userId])
  await pool.end()
  await rm(temporary, { recursive: true, force: true })
}

process.stdin.once('data', () => cleanup().then(() => process.exit(0)))
process.on('SIGTERM', () => cleanup().then(() => process.exit(0)))
