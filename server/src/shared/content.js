/** 剧本文档：统一清洗富文本、生成纯文本稿和版本内容。 */
import sanitize from 'sanitize-html'
import { ensure } from './errors.js'
const nodes = new Set([
  'doc',
  'paragraph',
  'text',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'hardBreak',
  'horizontalRule',
])
const marks = new Set(['bold', 'italic', 'strike', 'code', 'underline', 'link'])

/**
 * 递归校验编辑器 JSON 的根节点、节点类型、标记及子节点结构。
 * 允许缺省文档，但限制递归深度小于 40；不支持的结构直接拒绝保存。
 */
export function validateDocument(doc, depth = 0) {
  if (doc == null && depth === 0) return
  ensure(
    doc && typeof doc === 'object' && depth < 40 && nodes.has(doc.type),
    400,
    'DOCUMENT_INVALID',
    '剧本文档格式无效'
  )
  ensure(depth !== 0 || doc.type === 'doc', 400, 'DOCUMENT_INVALID', '文档根节点必须为 doc')
  if (doc.marks !== undefined) {
    ensure(Array.isArray(doc.marks), 400, 'DOCUMENT_INVALID', '文本标记必须为数组')
    for (const m of doc.marks) ensure(m && marks.has(m.type), 400, 'DOCUMENT_INVALID', '不支持的文本标记')
  }
  if (doc.type === 'text') ensure(typeof doc.text === 'string', 400, 'DOCUMENT_INVALID', '文本节点内容无效')
  if (doc.content !== undefined) {
    ensure(Array.isArray(doc.content), 400, 'DOCUMENT_INVALID', '文档子节点必须为数组')
    for (const n of doc.content) validateDocument(n, depth + 1)
  }
}

/**
 * 验证编辑器文档，并用标签、属性和协议白名单清洗 HTML。
 * JSON 文档、清洗后的 HTML 和纯文本分别保留，供编辑、展示和导出使用。
 */
export function cleanContent(input) {
  validateDocument(input.document)
  return {
    document: input.document || null,
    html: sanitize(input.html || '', {
      allowedTags: [
        'p',
        'h1',
        'h2',
        'h3',
        'h4',
        'strong',
        'em',
        's',
        'u',
        'br',
        'ul',
        'ol',
        'li',
        'blockquote',
        'pre',
        'code',
        'hr',
        'a',
      ],
      allowedAttributes: { a: ['href', 'target', 'rel'] },
      allowedSchemes: ['http', 'https', 'mailto'],
    }),
    text: input.text || '',
  }
}

/**
 * 转义文本中的 HTML 特殊字符，避免模型正文被当作标签执行。
 */
export const escapeHtml = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/**
 * 将模型纯文本转为编辑器 HTML，场景行作为标题，其余按段落处理。
 * 每行先转义，模型空行不再转换为额外空段落。
 */
export const textToHtml = (text) =>
  text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) =>
      line.startsWith('【场景') ? `<h2>${escapeHtml(line)}</h2>` : `<p>${escapeHtml(line) || '<br>'}</p>`
    )
    .join('')
