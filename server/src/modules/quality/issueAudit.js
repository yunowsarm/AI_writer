/** 优化验收清单：逐项核对原问题，新增问题必须有候选原文证据，不能用整体偏好代替验收。 */
import { z } from 'zod'

export const issueAuditSchema = z.object({
  checks: z
    .array(z.object({ issueId: z.string(), A: z.enum(['present', 'absent', 'uncertain']), B: z.enum(['present', 'absent', 'uncertain']), quoteA: z.string().max(300), quoteB: z.string().max(300) }))
    .max(500),
  introduced: z
    .array(
      z.object({
        version: z.enum(['A', 'B']),
        dimension: z.enum(['character', 'plot', 'rhythm', 'dialogue', 'format']),
        severity: z.enum(['minor', 'major', 'critical']),
        confidence: z.number().min(0).max(1),
        quote: z.string().min(1).max(300),
        reason: z.string().min(1).max(500)
      })
    )
    .max(20)
})

/** 两次顺序的清单必须完整、无重复且引用真实；清单不完整时保留人工确认。 */
export function auditIssues(change, reviews) {
  const ids = [...new Set((change.issues || []).map((i) => i.id))]
  const added = new Map()
  const states = new Map(ids.map((id) => [id, []]))
  for (const [index, review] of reviews.entries()) {
    const audit = review.issueAudit
    if (!Array.isArray(audit?.checks) || !Array.isArray(audit?.introduced) || audit.checks.length !== ids.length || new Set(audit.checks.map((c) => c.issueId)).size !== ids.length)
      return { status: 'review', reason: '原问题验收清单缺失或不完整，请重新复核' }
    const candidate = index === 0 ? 'B' : 'A',
      source = index === 0 ? 'A' : 'B'
    const versions = { [candidate]: change.after, [source]: change.before }
    for (const check of audit.checks) {
      if (!states.has(check.issueId)) return { status: 'review', reason: '复核返回了不属于本次优化的问题' }
      for (const version of ['A', 'B']) {
        const quote = check['quote' + version]
        if ((check[version] === 'present' && !quote) || (quote && !versions[version].includes(quote))) return { status: 'review', reason: '问题验收引用无法在对应版本中验证' }
      }
      states.get(check.issueId).push({ before: check[source], after: check[candidate] })
    }
    for (const finding of audit.introduced) {
      if (!versions[finding.version]?.includes(finding.quote)) return { status: 'review', reason: '新增问题引用不真实，需人工确认' }
      if (finding.version === candidate) added.set((finding.dimension || '') + ':' + finding.quote.replace(/\s/g, ''), finding)
    }
  }
  const resolved = [...states.values()].filter((s) => s.every((r) => r.before === 'present' && r.after === 'absent')).length
  const remaining = [...states.values()].filter((s) => s.some((r) => r.after === 'present')).length
  const summary = { checked: ids.length, resolved, remaining, uncertain: ids.length - resolved - remaining, added: added.size, newIssues: [...added.values()] }
  if ([...added.values()].some((i) => i.confidence >= 0.8)) return { status: 'rejected', reason: '复核发现候选新增问题，已保留原稿', summary }
  if (added.size || resolved !== ids.length) return { status: 'review', reason: '原问题尚未全部确认解决，或存在疑似新增问题，默认保留原稿', summary }
  return { status: 'completed', reason: '逐项验收确认原问题已解决，未报告新增问题', summary }
}
