/** 合并相邻的相同操作，供编辑标注和历史版本对比共同使用。 */
function compact(parts) {
  const result = []
  for (const part of parts) {
    if (!part.text) continue
    if (result.at(-1)?.type === part.type) result.at(-1).text += part.text
    else result.push({ ...part })
  }
  return result
}

/**
 * 先移除公共首尾，再对改变区域计算字符级最长公共子序列。
 * 超过 100 万单元时降级为一次替换，保证长剧本仍能流畅编辑；保留原文与新文的完整可逆表示。
 */
export function diffText(before, after) {
  if (before === after) return before ? [{ type: 'equal', text: before }] : []
  let start = 0,
    end = 0
  while (start < Math.min(before.length, after.length) && before[start] === after[start]) start++
  while (end < Math.min(before.length, after.length) - start && before[before.length - end - 1] === after[after.length - end - 1]) end++
  const a = before.slice(start, before.length - end),
    b = after.slice(start, after.length - end)
  const parts = [{ type: 'equal', text: before.slice(0, start) }]
  if ((a.length + 1) * (b.length + 1) <= 1000000) {
    const scores = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) scores[i][j] = a[i] === b[j] ? 1 + scores[i + 1][j + 1] : Math.max(scores[i + 1][j], scores[i][j + 1])
    let i = 0,
      j = 0
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        parts.push({ type: 'equal', text: a[i++] })
        j++
      } else if (i < a.length && (j === b.length || scores[i + 1][j] >= scores[i][j + 1])) parts.push({ type: 'delete', text: a[i++] })
      else parts.push({ type: 'insert', text: b[j++] })
    }
  } else parts.push({ type: 'delete', text: a }, { type: 'insert', text: b })
  if (end) parts.push({ type: 'equal', text: before.slice(-end) })
  return compact(parts)
}
