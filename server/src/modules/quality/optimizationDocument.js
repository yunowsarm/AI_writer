/** 批量优化的文档边界：只替换命中的文本块，其他富文本标记、标题和列表保持原样。 */
import { parseDocument } from 'htmlparser2'
import render from 'dom-serializer'
import { json } from '../../db/index.js'
import { textToHtml, cleanContent } from '../../shared/content.js'
import { ensure } from '../../shared/errors.js'

const textTypes = new Set(['paragraph', 'heading', 'codeBlock'])
const htmlTypes = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre'])
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** 读取节点真实文本，软换行不能拼成另一句台词。 */
function nodeText(node, html = false) {
  if (node.type === 'text') return html ? node.data : node.text || ''
  if (html ? node.name === 'br' : node.type === 'hardBreak') return '\n'
  return (html ? node.children || [] : node.content || []).map((n) => nodeText(n, html)).join('')
}

/** 列出独立文本块，JSON 优先；旧版只有 HTML 的剧本也保留未改动节点。 */
export function episodeBlocks(episode) {
  const blocks = [],
    document = json(episode.document_json)
  const root = document || parseDocument(episode.content_html || textToHtml(episode.content_text))
  function walk(node) {
    if (document ? textTypes.has(node.type) : htmlTypes.has(node.name)) blocks.push({ index: blocks.length, text: nodeText(node, !document) })
    else for (const child of document ? node.content || [] : node.children || []) walk(child)
  }
  walk(root)
  return blocks
}

/** 安全序列化编辑器 JSON，保留未改动文字的样式。 */
function documentHtml(node) {
  if (node.type === 'text') {
    let text = escape(node.text || '')
    const marks = { bold: 'strong', italic: 'em', strike: 's', code: 'code', underline: 'u' }
    for (const mark of node.marks || []) {
      if (marks[mark.type]) text = `<${marks[mark.type]}>${text}</${marks[mark.type]}>`
      else if (mark.type === 'link') text = `<a href="${escape(mark.attrs?.href || '')}">${text}</a>`
    }
    return text
  }
  if (node.type === 'hardBreak') return '<br>'
  if (node.type === 'horizontalRule') return '<hr>'
  const content = (node.content || []).map(documentHtml).join('')
  const tags = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', blockquote: 'blockquote' }
  if (node.type === 'heading') {
    const tag = 'h' + Math.max(1, Math.min(6, node.attrs?.level || 2))
    return `<${tag}>${content}</${tag}>`
  }
  if (node.type === 'codeBlock') return `<pre><code>${content}</code></pre>`
  if (node.type === 'orderedList') return `<ol start="${Number(node.attrs?.start) || 1}">${content}</ol>`
  return tags[node.type] ? `<${tags[node.type]}>${content}</${tags[node.type]}>` : content
}

/** 按初始块编号一次性替换，删除不会让后续段落编号偏移。 */
export function optimizeDocument(episode, changes) {
  const replacements = new Map(changes.map((c) => [c.blockIndex, c]))
  let index = 0,
    document = json(episode.document_json),
    html
  if (document) {
    function replace(node) {
      if (textTypes.has(node.type)) {
        const change = replacements.get(index++)
        if (!change) return [node]
        ensure(nodeText(node) === change.before, 409, 'OPTIMIZATION_DOCUMENT_CHANGED', '段落内容已变化，请重新优化')
        if (change.kind === 'delete') return []
        return change.after
          .split('\n')
          .filter((s) => s.trim())
          .map((s, i) => ({
            type: i === 0 && node.type === 'heading' ? 'heading' : 'paragraph',
            ...(i === 0 && node.type === 'heading' ? { attrs: node.attrs } : {}),
            content: [{ type: 'text', text: s }]
          }))
      }
      const content = (node.content || []).flatMap(replace)
      if (['listItem', 'bulletList', 'orderedList', 'blockquote'].includes(node.type) && !content.length) return []
      return [{ ...node, ...(node.content ? { content } : {}) }]
    }
    document = replace(document)[0]
    if (!document.content?.length) document.content = [{ type: 'paragraph' }]
    html = documentHtml(document)
  } else {
    const root = parseDocument(episode.content_html || textToHtml(episode.content_text))
    function replace(node) {
      if (htmlTypes.has(node.name)) {
        const change = replacements.get(index++)
        if (!change) return [node]
        ensure(nodeText(node, true) === change.before, 409, 'OPTIMIZATION_DOCUMENT_CHANGED', '段落内容已变化，请重新优化')
        return change.kind === 'delete' ? [] : parseDocument(textToHtml(change.after)).children
      }
      if (node.children) node.children = node.children.flatMap(replace)
      return [node]
    }
    replace(root)
    html = render(root)
    if (!html.trim()) html = '<p></p>'
  }
  const text = episodeBlocks({ document_json: document, content_html: html, content_text: '' })
    .map((b) => b.text)
    .join('\n\n')
  return cleanContent({ document, html, text })
}
