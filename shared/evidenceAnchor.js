/** 与评估器保持一致：非空行分段，超长行每 1200 字建立一个证据位置。 */
function paragraphs(text) {
  const result = []
  for (const match of text.matchAll(/[^\n]+/g)) {
    if (!match[0].trim()) continue
    for (let i = 0; i < match[0].length; i += 1200) result.push({ text: match[0].slice(i, i + 1200), offset: match.index + i })
  }
  return result
}

/**
 * 用段落编辑距离对齐快照与现稿，替换、插入和删除都计一次编辑。
 * 检查所有最优路径：只有原段落在所有路径中都对应同一处时才允许自动定位，避免删掉一处后误改另一处。
 * 单集过大时保守返回不唯一，限制浏览器内存占用。
 */
function alignParagraph(before, after, target) {
  const n = before.length,
    m = after.length
  if ((n + 1) * (m + 1) > 4000000) return { status: 'ambiguous' }
  const cost = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n; i >= 0; i--) {
    for (let j = m; j >= 0; j--) {
      if (i === n) cost[i][j] = m - j
      else if (j === m) cost[i][j] = n - i
      else cost[i][j] = Math.min(cost[i + 1][j] + 1, cost[i][j + 1] + 1, cost[i + 1][j + 1] + (before[i].text === after[j].text ? 0 : 1))
    }
  }
  let reachable = new Uint8Array(m + 1)
  reachable[0] = 1
  const matches = new Set()
  let changed = false
  for (let i = 0; i <= target; i++) {
    const next = new Uint8Array(m + 1)
    for (let j = 0; j <= m; j++) {
      if (!reachable[j]) continue
      if (j < m && cost[i][j] === cost[i][j + 1] + 1) reachable[j + 1] = 1
      if (cost[i][j] === cost[i + 1][j] + 1) {
        next[j] = 1
        if (i === target) changed = true
      }
      if (j < m) {
        const same = before[i].text === after[j].text
        if (cost[i][j] === cost[i + 1][j + 1] + (same ? 0 : 1)) {
          next[j + 1] = 1
          if (i === target) {
            matches.add(j)
          }
        }
      }
    }
    reachable = next
  }
  if (!matches.size) return { status: 'changed' }
  if (changed || matches.size !== 1) return { status: 'ambiguous' }
  return { status: 'available', index: [...matches][0] }
}

/** 先依据快照段落身份定位，再返回当前引用序号供富文本映射；旧调用仍要求文字唯一。 */
export function locateQuotedText(text, quote, evidence = {}) {
  if (!quote) return { status: 'missing' }
  const paragraphNumber = Number(evidence.paragraphId?.match(/-p(\d+)$/)?.[1])
  if (evidence.snapshotText != null && paragraphNumber) {
    const before = paragraphs(evidence.snapshotText),
      after = paragraphs(text)
    const target = paragraphNumber - 1
    const original = before[target]
    if (!original || !original.text.includes(quote)) return { status: 'changed' }
    const aligned = evidence.snapshotText === text ? { status: 'available', index: target } : alignParagraph(before, after, target)
    if (aligned.status !== 'available') return aligned
    const current = after[aligned.index].text
    const local = current.indexOf(quote)
    if (local < 0) return { status: 'changed' }
    if (current.indexOf(quote, local + 1) >= 0 || original.text.indexOf(quote, original.text.indexOf(quote) + 1) >= 0) return { status: 'ambiguous' }
    const from = after[aligned.index].offset + local
    let occurrence = 0
    for (let p = text.indexOf(quote); p >= 0 && p < from; p = text.indexOf(quote, p + 1)) occurrence++
    return { status: 'available', from, to: from + quote.length, occurrence }
  }
  const start = text.indexOf(quote)
  if (start < 0) return { status: 'changed' }
  if (text.indexOf(quote, start + 1) >= 0) return { status: 'ambiguous' }
  return { status: 'available', from: start, to: start + quote.length }
}
