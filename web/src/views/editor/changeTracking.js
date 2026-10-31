/** 编辑视图插件：失焦仍显示选区；本轮新增/删除仅用装饰层展示，不写入文档或导出。 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { diffText } from './textDiff.js'

export const reviewKey = new PluginKey('scriptReview')

/** 将纯文本下标映射回真实文档位置，兼容段落、标题、换行与样式拆分。 */
function textMap(doc) {
  let text = ''
  const positions = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return
    if (text) {
      text += '\n'
      positions.push(pos)
    }
    node.descendants((child, offset) => {
      const value = child.isText ? child.text : child.type.name === 'hardBreak' ? '\n' : ''
      for (let i = 0; i < value.length; i++) {
        text += value[i]
        positions.push(pos + 1 + offset + i)
      }
    })
    return false
  })
  positions.push(Math.max(0, doc.content.size - 1))
  return { text, positions }
}

/** 用当前正文生成新增高亮与删除标记；纯视图装饰不影响保存和复制的最新正文。 */
function changesFor(doc, baseline) {
  const current = textMap(doc),
    decorations = []
  let offset = 0,
    index = 0
  for (const part of diffText(baseline, current.text)) {
    const from = current.positions[offset] ?? Math.max(0, doc.content.size - 1)
    if (part.type === 'insert') {
      const to = (current.positions[offset + part.text.length - 1] ?? from) + 1
      if (to > from) decorations.push(Decoration.inline(from, Math.min(to, doc.content.size), { class: 'review-insert', title: '本轮新增内容' }))
    }
    if (part.type === 'delete') {
      decorations.push(
        Decoration.widget(
          from,
          () => {
            const label = document.createElement('del')
            label.className = 'review-delete'
            label.contentEditable = 'false'
            label.title = '已删除：' + part.text
            label.setAttribute('aria-label', label.title)
            label.textContent = part.text.length > 60 ? part.text.slice(0, 60) + '…' : part.text
            return label
          },
          { side: -1, key: 'deleted-' + index++ }
        )
      )
    } else offset += part.text.length
  }
  return DecorationSet.create(doc, decorations)
}

/** 单独导出插件，回归检查可直接验证失焦选区、撤销及保存基线。 */
export function createReviewPlugin() {
  return new Plugin({
    key: reviewKey,
    state: {
      init: (_, state) => ({ baseline: textMap(state.doc).text, decorations: DecorationSet.empty }),
      apply(tr, value) {
        if (tr.getMeta(reviewKey) === 'commit') return { baseline: textMap(tr.doc).text, decorations: DecorationSet.empty }
        return tr.docChanged ? { baseline: value.baseline, decorations: changesFor(tr.doc, value.baseline) } : value
      }
    },
    props: {
      decorations(state) {
        const value = reviewKey.getState(state)
        const { from, to, empty } = state.selection
        return empty ? value.decorations : value.decorations.add(state.doc, [Decoration.inline(from, to, { class: 'persistent-selection' })])
      }
    }
  })
}

export const ChangeTracking = Extension.create({
  name: 'scriptReview',
  addCommands() {
    return {
      confirmReviewChanges:
        () =>
        ({ tr, dispatch }) => {
          if (dispatch) tr.setMeta(reviewKey, 'commit').setMeta('addToHistory', false)
          return true
        }
    }
  },
  addProseMirrorPlugins: () => [createReviewPlugin()]
})
