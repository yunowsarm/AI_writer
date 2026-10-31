/** 编辑器文档工具：可视格式化与段落顺序移动，保持为 Tiptap 结构。 */

/**
 * 转义纯文本的 HTML 特殊字符，避免模型或用户内容被解释为标签。
 */
export const escapeHtml = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/**
 * 逐行规范场景、人物、动作旁白及台词标记，再输出转义后的标题或段落 HTML。
 * 格式化会跳过空白行，实际内容变更由编辑器保存流程记录历史。
 */
export function standardize(text) {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      const s = line
        .trim()
        .replace(/^场景\s*[：:]?\s*/, '【场景】')
        .replace(/^人物\s*[：:]?\s*/, '【人物】')
        .replace(/^(旁白|动作)\s*[：:]?\s*/, '【动作旁白】')
        .replace(/^([^【：:]{1,12}):/, '$1：')
      return /^【场景/.test(s) ? `<h2>${escapeHtml(s)}</h2>` : `<p>${escapeHtml(s) || '<br>'}</p>`
    })
    .join('')
}

/**
 * 将引用映射到富文本文档位置，支持同一段落中的换行和跨多个样式文本节点。
 * 引用序号须由快照对齐验证后传入；没有锚点时仍只接受唯一匹配。
 */
export function findQuoteRange(doc, quote, anchor) {
  const matches = []
  doc.descendants((node, position) => {
    if (!node.isTextblock) return
    let text = ''
    const positions = []
    node.descendants((child, offset) => {
      const value = child.isText ? child.text : child.type.name === 'hardBreak' ? '\n' : ''
      for (let i = 0; i < value.length; i++) {
        text += value[i]
        positions.push(position + 1 + offset + i)
      }
    })
    let from = text.indexOf(quote)
    while (quote && from >= 0) {
      matches.push({ from: positions[from], to: positions[from + quote.length - 1] + 1 })
      from = text.indexOf(quote, from + 1)
    }
    return false
  })
  return Number.isInteger(anchor?.occurrence) ? matches[anchor.occurrence] || null : matches.length === 1 ? matches[0] : null
}

/**
 * 删除建议按真实文本块取范围，引用即使只有前 120 字也不会留下半段残文。
 * 仅接受同一段内的真实引用，删除计划还需在应用前核对当前文档与 revision。
 */
export function planParagraphDeletion(doc, range, quote) {
  if (!range || range.from < 0 || range.to > doc.content.size || range.from >= range.to) throw new Error('删除范围无效，请重新定位原文')
  const start = doc.resolve(range.from),
    end = doc.resolve(range.to)
  if (!start.parent.isTextblock || !start.sameParent(end) || !doc.textBetween(range.from, range.to, '\n').includes(quote)) throw new Error('引用跨越多个段落，请手动选中要删除的内容')
  return { from: start.before(), to: start.after(), text: start.parent.textBetween(0, start.parent.content.size, '\n', '\n') }
}
