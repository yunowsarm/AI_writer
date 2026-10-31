/** 将选中原文居中到实际滚动视口；不依赖浏览器默认的“刚好可见”滚动。 */
export function centerSelection(editor, range) {
  const view = editor.view
  let scroller = view.dom.parentElement
  while (scroller && scroller !== document.body) {
    if (/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight) break
    scroller = scroller.parentElement
  }
  const nested = scroller && scroller !== document.body && scroller !== document.documentElement
  const viewport = nested ? scroller.getBoundingClientRect() : { top: 0, height: window.innerHeight }
  const start = view.coordsAtPos(range.from)
  const end = view.coordsAtPos(range.to)
  // 长引用优先展示开头，避免居中后看不到证据起点。
  const target = start.top + Math.min(end.bottom - start.top, viewport.height * 0.6) / 2
  const top = target - (viewport.top + viewport.height / 2)
  if (nested) scroller.scrollTop += top
  else window.scrollBy({ top, behavior: 'instant' })
}
