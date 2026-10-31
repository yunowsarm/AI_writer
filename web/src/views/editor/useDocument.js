/** 自动保存模块：串行请求与乐观锁；保存中继续输入也不会覆盖新正文。 */
import { ref } from 'vue'
import { api } from '../../api/client'
import { history } from '@tiptap/pm/history'

/**
 * 封装分集加载、脏状态、延迟保存及串行请求，供编辑器页面统一使用。
 * epoch 标记内容变更次数，pending 保证同一时刻只有一个保存请求。
 */
export function useDocument(editor) {
  const episode = ref(null),
    dirty = ref(false),
    saving = ref(false),
    saveError = ref('')
  let timer = null,
    pending = null,
    epoch = 0

  /**
   * 切换当前分集并设置编辑器内容，关闭此次赋值的更新事件，避免误触发自动保存。
   */
  function loadEpisode(value) {
    clearTimeout(timer)
    if (!value) {
      episode.value = null
      dirty.value = false
      saveError.value = ''
      epoch++
      editor.value.commands.setContent('<p></p>', { emitUpdate: false })
      editor.value.commands.confirmReviewChanges()
      return
    }
    const sameEpisode = episode.value?.id === value.id
    episode.value = { ...value }
    epoch++
    saveError.value = ''
    const html = (value.content_html || '').replace(/<p>\s*(?:<br\s*\/?>)?\s*<\/p>/gi, '')
    // 定位建议时，同一集的最新正文已在本地，保留撤销栈、选区和本轮修改标注。
    if (!sameEpisode || JSON.stringify(value.document_json) !== JSON.stringify(editor.value.getJSON())) {
      const unchanged = sameEpisode && editor.value.getHTML() === html
      if (!unchanged) {
        editor.value.commands.setContent(value.document_json || html || '<p></p>', { emitUpdate: false })
        // 通过 Tiptap 的插件接口重置历史，保证 Vue 的响应状态也同步，不能直接覆盖 view.state。
        editor.value.unregisterPlugin('history')
        editor.value.registerPlugin(history())
        editor.value.commands.confirmReviewChanges()
      }
    }
    dirty.value = false
  }

  /**
   * 标记正文已变更并递增 epoch，以 1.6 秒防抖安排自动保存。
   */
  function changed() {
    dirty.value = true
    epoch++
    saveError.value = ''
    clearTimeout(timer)
    timer = setTimeout(() => save('自动保存').catch(() => {}), 1600)
  }

  /**
   * 等待已有保存完成后再提交最新内容，使用后端 revision 做乐观锁校验。
   * 发起时固定分集 ID 和 epoch；响应只更新同一分集的 revision，输入未再变化时才清除 dirty。
   * 失败保留未保存状态及错误消息，让页面决定重试或离开处理。
   */
  async function save(reason = '手动保存') {
    clearTimeout(timer)
    if (pending) {
      await pending
      if (dirty.value) return save(reason)
      return
    }
    if (!episode.value || !dirty.value) return
    // 请求使用发送时的内容快照，后续输入不会改变已提交的 payload。
    const current = episode.value,
      id = current.id,
      stamp = epoch,
      payload = {
        title: current.title,
        document: editor.value.getJSON(),
        html: editor.value.getHTML(),
        text: editor.value.getText(),
        revision: current.revision,
        reason
      }
    saving.value = true
    saveError.value = ''
    pending = (async () => {
      try {
        const result = await api('/episodes/' + id, { method: 'PATCH', body: payload })
        if (episode.value?.id === id) {
          episode.value.revision = result.revision
          // 保存期间如果继续输入，只接受新 revision，保留 dirty 以便再次保存新内容。
          if (epoch === stamp) dirty.value = false
        }
      } catch (e) {
        saveError.value = e.message
        throw e
      } finally {
        saving.value = false
        pending = null
      }
    })()
    await pending
  }

  /**
   * 清理待触发的自动保存定时器；页面卸载前由编辑器调用。
   */
  function dispose() {
    clearTimeout(timer)
  }
  return { episode, dirty, saving, saveError, loadEpisode, changed, save, dispose }
}
