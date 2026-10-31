/** 优化计划：合并同段意见，校验证据，保守识别可直接删除的同集完全重复。 */
import { createHash } from 'node:crypto'
import { locateQuotedText } from '../../../../shared/evidenceAnchor.js'
import { qualityActionKind, remainingEvidence } from '../../../../shared/qualityResolution.js'
import { episodeBlocks } from './optimizationDocument.js'
import { advisoryIssue } from './scoring.js'

/** 对照快照定位引用，再映射到富文本块；多处相同原文必须保留出现序号。 */
function evidenceBlock(evidence, snapshot, episode, blocks) {
  if (!snapshot || !episode) return null
  const anchor = locateQuotedText(episode.content_text, evidence.quote, { snapshotText: snapshot.content_text, paragraphId: evidence.paragraphId })
  if (anchor.status !== 'available') return null
  const matches = []
  for (const block of blocks) for (let from = block.text.indexOf(evidence.quote); from >= 0; from = block.text.indexOf(evidence.quote, from + 1)) matches.push(block)
  return matches[anchor.occurrence ?? 0] || null
}

/** 计划不写正文：用户可在启动前看到调用数、删除数与需手动确认的问题。 */
export function buildOptimizationPlan(report, episodes, resolvedIssues = [], resolvedEvidence = []) {
  const units = new Map(),
    skipped = [],
    rank = { critical: 0, major: 1, minor: 2 }
  const blocks = new Map(episodes.map((e) => [e.id, episodeBlocks(e)]))
  const add = (issue, evidence, block, kind, whole = false) => {
    const episode = episodes.find((e) => e.id === evidence.episodeId)
    const id = `e${episode.id}-b${block.index}`
    if (!units.has(id))
      units.set(id, {
        id,
        episodeId: episode.id,
        episodeNo: episode.episode_no,
        blockIndex: block.index,
        before: block.text,
        after: '',
        kind,
        issues: [],
        evidence: [],
        wholeIssues: [],
        priority: rank[issue.severity] ?? 3,
        status: 'pending'
      })
    const unit = units.get(id)
    if (kind === 'delete') unit.kind = 'delete'
    unit.priority = Math.min(unit.priority, rank[issue.severity] ?? 3)
    if (!unit.issues.some((i) => i.id === issue.id)) unit.issues.push({ id: issue.id, dimension: issue.dimension, title: issue.title, suggestion: issue.suggestion, explanation: issue.explanation })
    if (!unit.evidence.some((e) => e.issueId === issue.id && e.paragraphId === evidence.paragraphId)) unit.evidence.push({ issueId: issue.id, paragraphId: evidence.paragraphId })
    if (whole && !unit.wholeIssues.includes(issue.id)) unit.wholeIssues.push(issue.id)
  }
  const locate = (evidence) => {
    const episode = episodes.find((e) => e.id === evidence.episodeId)
    return evidenceBlock(
      evidence,
      report.snapshot.episodes.find((e) => e.id === evidence.episodeId),
      episode,
      blocks.get(episode?.id) || []
    )
  }
  for (const issue of report.result?.issues || []) {
    if (resolvedIssues.includes(issue.id)) continue
    const remaining = remainingEvidence(issue, resolvedEvidence)
    if (!remaining.length && issue.evidence.length) continue
    const skip = (reason) => skipped.push({ issueId: issue.id, title: issue.title, reason })
    if (advisoryIssue(issue)) {
      skip('仅作创作提示，不扣分、不自动改写')
      continue
    }
    if (issue.needsConfirmation || issue.confidence < 0.7) {
      skip('置信度较低，需作者确认')
      continue
    }
    if (!remaining.length) {
      skip('缺少可定位的原文，需手动处理')
      continue
    }
    if (issue.source === 'consistency' || (issue.dimension === 'character' && new Set(issue.evidence.map((e) => e.episodeId)).size > 1)) {
      skip('涉及多处事实的取舍，需作者选择应修改的一侧，避免同时改写正确证据')
      continue
    }
    if (qualityActionKind(issue) === 'delete-preview') {
      const references = issue.evidence.map((e) => ({ evidence: e, block: locate(e) }))
      const sameEpisode = new Set(references.map((r) => r.evidence.episodeId)).size === 1
      const identical = references.length >= 2 && references.every((r) => r.block && r.block.text.trim() === references[0].block.text.trim())
      const distinct = new Set(references.map((r) => r.block?.index)).size === references.length
      if (!sameEpisode || !identical || !distinct) {
        skip('跨集、相似但不完全相同或位置已变动，需确认后删除')
        continue
      }
      const ordered = references.sort((a, b) => a.block.index - b.block.index)
      for (const r of ordered.slice(1)) add(issue, r.evidence, r.block, 'delete', references.length === 2)
    } else {
      for (const evidence of remaining) {
        const block = locate(evidence)
        if (!block) {
          skip('原文已改动或位置不唯一，需重新评估')
          continue
        }
        if (block.text.length > 50000) {
          skip('单段过长，请拆分后处理')
          continue
        }
        add(issue, evidence, block, 'rewrite')
      }
    }
  }
  const changes = [...units.values()].sort((a, b) => a.priority - b.priority || a.episodeNo - b.episodeNo || a.blockIndex - b.blockIndex)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ reportId: report.id, episodes: episodes.map((e) => [e.id, e.revision, e.content_text]), resolvedIssues, resolvedEvidence }))
    .digest('hex')
  return { fingerprint, changes, skipped, total: changes.length, aiCalls: changes.filter((c) => c.kind === 'rewrite').length, deletions: changes.filter((c) => c.kind === 'delete').length }
}
