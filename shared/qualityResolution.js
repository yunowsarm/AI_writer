/** 按证据位置判断完成状态，不能因一个位置被修改而清空整条建议。 */
export function remainingEvidence(issue, resolved = []) {
  return issue.evidence.filter((e) => !resolved.some((r) => r.issueId === issue.id && r.paragraphId === e.paragraphId))
}

/** 重复检测或明确的删除建议走删除预览；回环、伏笔等语义问题仍交由作者判断。 */
export function qualityActionKind(issue) {
  const description = [issue.title, issue.explanation, issue.suggestion].filter(Boolean).join(' ')
  if (/存在高度相似的段落/.test(issue.title || '')) return 'delete-preview'
  return /重复|冗余|赘余/.test(description) && /段落|整段|重复台词/.test(description) && /删除|删去|删掉|移除|去掉/.test(issue.suggestion || '') ? 'delete-preview' : 'rewrite'
}
