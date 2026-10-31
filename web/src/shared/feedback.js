/** 用户反馈：异步操作统一显示可读错误，取消操作不当作业务失败。 */
import { ElMessage, ElMessageBox } from 'element-plus'

/**
 * 显示操作成功提示，供各页面统一复用。
 */
export const success = (message) => ElMessage.success(message)

/**
 * 显示可读错误消息，忽略主动关闭弹窗、取消确认及请求取消。
 */
export function reportError(e) {
  if (e === 'cancel' || e === 'close' || e?.name === 'AbortError') return
  ElMessage.error(e.message || '操作失败，请稍后重试')
}

/**
 * 显示确认弹窗，确认返回 true，取消或关闭返回 false。
 */
export async function confirmAction(message, title = '操作确认') {
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

/**
 * 显示带非空校验的输入弹窗；确认返回输入文本，取消或关闭返回 null。
 */
export async function askText(title, message, value = '') {
  try {
    const { value: result } = await ElMessageBox.prompt(message, title, {
      inputValue: value,
      inputValidator: (v) => !!v?.trim() || '请输入内容',
      confirmButtonText: '确定',
      cancelButtonText: '取消',
    })
    return result
  } catch {
    return null
  }
}
