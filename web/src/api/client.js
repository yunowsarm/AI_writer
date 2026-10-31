/** HTTP 客户端：同源 Cookie、统一错误、可取消的 SSE 文本流。 */
import { windowSessionHeaders } from './windowSession'
export class ApiError extends Error {
  /** 保存 HTTP 状态、业务码及字段错误，供页面区分未登录、校验失败和普通异常。 */
  constructor(status, data) {
    super(data.message || '请求失败')
    this.status = status
    this.code = data.code
    this.details = data.details
  }
}

/**
 * 调用同源 JSON 接口，统一携带会话 Cookie 并转换业务错误。
 * @param {string} path 不含 /api 前缀的接口路径。
 * @param {object} options 请求选项；body 传普通对象，由此函数序列化。
 * @returns {Promise<*>} 后端 JSON 响应；非成功状态抛出 ApiError。
 */
export async function api(path, options = {}) {
  const response = await fetch('/api' + path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...windowSessionHeaders(), ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  })
  const data = await response.json().catch(() => ({ message: '服务响应无效' }))
  if (!response.ok) throw new ApiError(response.status, data)
  return data
}

/**
 * 发起可取消的 SSE 请求，逐个解析完整事件并等待 onEvent 回调。
 * 保留跨分块的 UTF-8 解码状态和未完成事件，心跳注释不会作为业务事件分发。
 * @param {string} path 不含 /api 前缀的流式接口路径。
 * @param {object} body 生成或改写参数。
 * @param {Function} onEvent 接收事件名称及解析后的数据。
 * @param {AbortSignal} signal 页面主动离开时可终止本地请求。
 * @param {string} method 默认 POST；订阅既有后台任务时使用 GET，不重新创建任务。
 * @returns {Promise<void>} 流读取结束时完成，网络或解析异常向调用方抛出。
 */
export async function streamApi(path, body, onEvent, signal, method = 'POST') {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...windowSessionHeaders() },
    body: JSON.stringify(body),
    signal
  })
  if (!response.ok) throw new ApiError(response.status, await response.json())
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
      let end
      // SSE 以空行分隔事件；不足一个完整事件时继续保留在 buffer 中等待下一块数据。
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const event = block
          .split('\n')
          .find((l) => l.startsWith('event:'))
          ?.slice(6)
          .trim()
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n')
        if (event && data) await onEvent(event, JSON.parse(data))
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * 请求作者专属导出接口，并通过临时对象 URL 触发浏览器下载。
 * @param {number} id 剧本 ID；是否有权导出仍由后端校验。
 * @param {string} type 导出格式 txt 或 md。
 * @param {string} title 下载文件标题。
 * 下载触发后延迟释放对象 URL，避免长期占用浏览器内存。
 */
export async function downloadScript(id, type, title) {
  const response = await fetch(`/api/scripts/${id}/export?type=${type}`, { credentials: 'same-origin', headers: windowSessionHeaders() })
  if (!response.ok) throw new ApiError(response.status, await response.json())
  const blob = await response.blob(),
    url = URL.createObjectURL(blob),
    a = document.createElement('a')
  a.href = url
  a.download = title + '.' + type
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
