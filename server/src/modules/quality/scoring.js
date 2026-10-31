/** 固定证据计分：只扣除已验证的问题，按分集等权汇总，避免模型自由分数和扩写篇幅改变权重。 */
export const scoringStandard = 'evidence-2.0'
export const severityPoints = { minor: 2, major: 6, critical: 12 }

/** 识别提示性约束；兼容旧报告，防止将整集时长建议当作首段改写任务。 */
export function advisoryIssue(issue) {
  return issue.advisory === true || /篇幅与目标时长|实际集数与计划/.test(issue.title)
}

/** 同维度同位置取最大扣分；多点证据分摊，不合并连通组，保证删去已解决问题不会增加扣分。 */
export function evidenceScores(episodes, issues, dimensions, complete) {
  const episodeIds = episodes.map((e) => e.id)
  const buckets = new Map()
  const positions = new Map()
  for (const issue of issues) {
    if (advisoryIssue(issue) || issue.needsConfirmation || issue.confidence < 0.7) continue
    const points = severityPoints[issue.severity] || 0
    const ids = [...new Set(issue.evidence.map((e) => e.episodeId).filter((id) => episodeIds.includes(id)))]
    // 没有原文依据的语义判断不计分；空集由评估覆盖错误处理，不能给出总分。
    if (!ids.length) continue
    for (const episodeId of ids) {
      const anchors = [...new Set(issue.evidence.filter((e) => e.episodeId === episodeId).map((e) => e.paragraphId))]
      for (const paragraphId of anchors) {
        const key = `${episodeId}:${issue.dimension}:${paragraphId}`
        const entry = positions.get(key) || { episodeId, dimension: issue.dimension, positions: [paragraphId], issueIds: [], points: 0 }
        entry.points = Math.max(entry.points, points / anchors.length)
        entry.issueIds.push(issue.id)
        positions.set(key, entry)
      }
    }
  }
  const deductions = [...positions.values()]
  for (const deduction of deductions) {
    const key = `${deduction.episodeId}:${deduction.dimension}`
    buckets.set(key, (buckets.get(key) || 0) + deduction.points)
  }
  return {
    dimensions: dimensions.map((d) => ({
      ...d,
      score: complete ? Math.round(episodeIds.reduce((sum, id) => sum + Math.max(0, 100 - (buckets.get(`${id}:${d.key}`) || 0)), 0) / Math.max(1, episodeIds.length)) : null
    })),
    scoring: { standard: scoringStandard, base: 100, severityPoints, aggregation: 'episode-equal', deductions, advisoryCount: issues.filter(advisoryIssue).length }
  }
}
