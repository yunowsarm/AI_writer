/** 质量算法：稳定段落索引、规则分析、字符三元组相似度、证据过滤与多维评分。 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { advisoryIssue, evidenceScores } from './scoring.js'

export const algorithmVersion = 'quality-2.0'
export const dimensions = [
  { key: 'character', label: '人物一致性', weight: 0.25 },
  { key: 'plot', label: '情节连贯性', weight: 0.25 },
  { key: 'rhythm', label: '节奏与冲突', weight: 0.2 },
  { key: 'dialogue', label: '台词表现', weight: 0.15 },
  { key: 'format', label: '格式与约束', weight: 0.15 }
]

/** 内容与算法版本一起参与指纹计算，模型选择单独参与报告缓存条件。 */
export function fingerprint(snapshot) {
  return createHash('sha256')
    .update(JSON.stringify({ version: algorithmVersion, snapshot: { ...snapshot, episodes: snapshot.episodes.map(({ revision, ...episode }) => episode) } }))
    .digest('hex')
}

/** 按非空行建立位置；超长段落分块，保留字符偏移，用于安全定位编辑器原文。 */
export function parseScript(snapshot) {
  return snapshot.episodes.map((episode) => {
    let scene = 0,
      index = 0
    const paragraphs = []
    const pattern = /[^\n]+/g
    let match
    while ((match = pattern.exec(episode.content_text))) {
      if (!match[0].trim()) continue
      const sceneLine = /^\s*(?:【场景】|场景\s*[:：]|第.+场|INT\.|EXT\.)/i.test(match[0])
      if (sceneLine) scene++
      for (let start = 0; start < match[0].length; start += 1200) {
        const text = match[0].slice(start, start + 1200)
        paragraphs.push({ id: `e${episode.id}-p${++index}`, episodeId: episode.id, episodeNo: episode.episode_no, scene, offset: match.index + start, text })
      }
    }
    return { ...episode, paragraphs, characters: episode.content_text.replace(/\s/g, '').length }
  })
}

/** 从正文提取三元字符集合；对中文无须依赖分词词典。 */
export function shingles(text) {
  const normalized = text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()
  return new Set(Array.from({ length: Math.max(0, normalized.length - 2) }, (_, i) => normalized.slice(i, i + 3)))
}

/** Jaccard 相似度：共有三元组数量除以并集数量，用于提示内部重复段落。 */
export function jaccard(left, right) {
  let common = 0
  for (const token of left) if (right.has(token)) common++
  return common / Math.max(1, left.size + right.size - common)
}

/**
 * 倒排索引先筛选共享三元组的候选，再做精确集合比较。
 * 相似提示仅代表本剧本内部重复，不推断版权或原创程度。
 */
export function repeatedParagraphs(episodes) {
  const index = new Map(),
    prior = [],
    issues = []
  for (const paragraph of episodes.flatMap((episode) => episode.paragraphs)) {
    if (paragraph.text.replace(/\s/g, '').length < 24) continue
    const tokens = shingles(paragraph.text)
    const candidates = new Map()
    for (const token of tokens) for (const id of index.get(token) || []) candidates.set(id, (candidates.get(id) || 0) + 1)
    for (const [id, overlap] of [...candidates].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
      const earlier = prior[id]
      if (overlap / Math.max(tokens.size, earlier.tokens.size) < 0.85) continue
      const similarity = jaccard(tokens, earlier.tokens)
      if (similarity < 0.85) continue
      issues.push({
        dimension: 'dialogue',
        severity: 'minor',
        confidence: 1,
        source: 'rule',
        title: '存在高度相似的段落',
        explanation: `字符三元组 Jaccard 相似度为 ${Math.round(similarity * 100)}%，请确认是否为有意重复。`,
        suggestion: '确认不是刻意回环或重复镜头后，保留其中一处并删除重复段落；若两处各有独立信息，可合并信息或改写。',
        evidence: [earlier.paragraph, paragraph].map((p) => ({ paragraphId: p.id, quote: p.text.slice(0, 120) }))
      })
      break
    }
    const id = prior.length
    prior.push({ paragraph, tokens })
    for (const token of tokens) {
      if (!index.has(token)) index.set(token, [])
      // 高频公共片段保留最近候选，控制长剧本的索引开销。
      const list = index.get(token)
      list.push(id)
      if (list.length > 100) list.shift()
    }
  }
  return issues
}

/** 检查格式、目标集数和篇幅；时长只作估计，轻微偏离不直接认定质量差。 */
export function ruleAnalysis(snapshot, episodes) {
  const issues = repeatedParagraphs(episodes)
  const add = (title, explanation, suggestion, paragraph, severity = 'minor', advisory = false) =>
    issues.push({
      dimension: 'format',
      title,
      explanation,
      suggestion,
      severity,
      confidence: 1,
      source: 'rule',
      advisory,
      evidence: paragraph ? [{ paragraphId: paragraph.id, quote: paragraph.text.slice(0, 120) }] : []
    })
  if (snapshot.config.episodes && snapshot.config.episodes !== episodes.length)
    add('实际集数与计划不符', `计划 ${snapshot.config.episodes} 集，当前 ${episodes.length} 集。`, '补齐分集，或在创作设定中调整目标集数。', null, 'minor', true)
  for (const episode of episodes) {
    if (!episode.paragraphs.length) {
      add(`第 ${episode.episode_no} 集尚无正文`, '该分集没有可评估的正文。', '补充正文后重新评估。', null, 'major')
      continue
    }
    const first = episode.paragraphs[0]
    if (!episode.paragraphs.some((p) => p.scene)) add('缺少场景标记', '该集未识别到【场景】或场景标题。', '补充地点、内外景与时间，便于拍摄。', first)
    if (!episode.paragraphs.some((p) => /【台词】|^[^：:\n]{1,15}[：:]/.test(p.text)))
      add('缺少可识别的角色台词', '该集未识别到角色名加冒号或【台词】标记。', '按“人物：台词”标注，或检查该集是否为有意无对白。', first)
    if (!episode.paragraphs.some((p) => /【动作旁白】|【动作】|【旁白】|^△|^（|^\(/.test(p.text)))
      add('缺少动作或旁白标记', '动作描述可能未与台词区分。', '使用【动作】、【旁白】或括号补充表演与环境信息。', first)
    const target = Number(snapshot.config.duration || 0)
    const estimatedMinutes = Math.round((episode.characters / 240) * 10) / 10
    episode.estimatedMinutes = estimatedMinutes
    if (target && (estimatedMinutes < target * 0.5 || estimatedMinutes > target * 2))
      add(
        '篇幅与目标时长偏离较大',
        `按每分钟约 240 字粗估为 ${estimatedMinutes} 分钟，目标为 ${target} 分钟；动作与剪辑会影响实际时长。`,
        '结合实际语速、停顿和镜头时长检查篇幅。',
        first,
        'minor',
        true
      )
  }
  return issues
}

const evidenceSchema = z.object({ paragraphId: z.string().max(60), quote: z.string().min(1).max(300) })
export const issueSchema = z.object({
  dimension: z.enum(['character', 'plot', 'rhythm', 'dialogue', 'format']),
  title: z.string().min(1).max(100),
  explanation: z.string().min(1).max(800),
  suggestion: z.string().min(1).max(800),
  severity: z.enum(['minor', 'major', 'critical']),
  confidence: z.number().min(0).max(1),
  advisory: z.boolean().optional(),
  evidence: z.array(evidenceSchema).min(1).max(4)
})
export const analysisSchema = z.object({
  scores: z.object({ character: z.number().min(0).max(100), plot: z.number().min(0).max(100), rhythm: z.number().min(0).max(100), dialogue: z.number().min(0).max(100) }).optional(),
  summary: z.string().max(800),
  facts: z.array(z.object({ character: z.string().max(80), attribute: z.string().max(80), value: z.string().max(200), time: z.string().max(80), evidence: evidenceSchema })).max(8),
  events: z.array(z.string().max(200)).max(8),
  rhythm: z.object({ conflict: z.number().min(0).max(100), reversal: z.number().min(0).max(100), suspense: z.number().min(0).max(100) }),
  issues: z.array(issueSchema).max(20)
})
export const consistencySchema = z.object({ issues: z.array(issueSchema).max(50), summary: z.string().max(1000) })

/** 拒绝不存在的引用；一致性矛盾必须至少给出两处不同的原文位置。 */
export function verifyIssues(issues, episodes, source = 'ai') {
  const paragraphs = new Map(episodes.flatMap((e) => e.paragraphs).map((p) => [p.id, p]))
  const seen = new Set()
  return issues.flatMap((issue) => {
    const evidence = issue.evidence
      .filter((entry) => paragraphs.get(entry.paragraphId)?.text.includes(entry.quote))
      .map((entry) => ({ ...entry, episodeId: paragraphs.get(entry.paragraphId).episodeId, episodeNo: paragraphs.get(entry.paragraphId).episodeNo }))
    if (issue.evidence.length !== evidence.length) return []
    if (source === 'consistency' && new Set(evidence.map((e) => e.paragraphId)).size < 2) return []
    const key =
      issue.dimension +
      ':' +
      evidence
        .map((e) => e.paragraphId)
        .sort()
        .join(',') +
      ':' +
      issue.title
    if (seen.has(key)) return []
    seen.add(key)
    return [{ ...issue, advisory: advisoryIssue(issue), evidence, source: issue.source || source, needsConfirmation: issue.confidence < 0.7 }]
  })
}

/** 固定规则计分；模型仅提取有证据的问题，冲突等曲线为描述指标，不参与总分。 */
export function buildReport(episodes, analyses, issues, consistencyComplete, errors = []) {
  const complete = errors.length === 0 && consistencyComplete && analyses.length > 0 && episodes.every((e) => e.paragraphs.length && analyses.some((a) => a.episodeId === e.id))
  const numberedIssues = issues.map((i, index) => ({ ...i, id: 'issue-' + (index + 1) }))
  const { dimensions: scores, scoring } = evidenceScores(episodes, numberedIssues, dimensions, complete)
  return {
    status: complete ? 'completed' : 'partial',
    algorithmVersion,
    dimensions: scores,
    total: complete ? Math.round(scores.reduce((sum, d) => sum + d.score * d.weight, 0)) : null,
    issues: numberedIssues,
    scoring,
    errors,
    coverage: { analyzedChunks: analyses.length, episodes: episodes.length, consistencyComplete },
    episodes: episodes.map((episode) => {
      const results = analyses.filter((a) => a.episodeId === episode.id)
      const weight = results.reduce((sum, a) => sum + a.characters, 0)
      const average = (key) => (weight ? Math.round(results.reduce((sum, a) => sum + a.result.rhythm[key] * a.characters, 0) / weight) : null)
      return {
        id: episode.id,
        episodeNo: episode.episode_no,
        title: episode.title,
        estimatedMinutes: episode.estimatedMinutes,
        conflict: average('conflict'),
        reversal: average('reversal'),
        suspense: average('suspense'),
        summaries: results.map((r) => r.result.summary)
      }
    })
  }
}
