/** 主题策略：独立管理偏好存储、系统变化和跨标签同步，不依赖业务账号或 API。 */
export const THEME_KEY = 'script-studio:theme'
export const themeModes = ['light', 'dark', 'system']

/** 仅接受三个约定值，缺失或损坏的持久化数据回退为随系统。 */
export function validTheme(value) {
  return themeModes.includes(value) ? value : 'system'
}

/** 明亮和暗色固定生效，只有随系统模式读取系统当前外观。 */
export function resolveTheme(mode, systemDark) {
  return mode === 'system' ? (systemDark ? 'dark' : 'light') : mode
}

/**
 * 创建主题控制器，所有浏览器依赖均通过参数注入，便于测试实时系统与跨标签变化。
 * 存储受限时仍可切换本页主题；dispose 统一移除监听，避免热更新或卸载后残留。
 */
export function createThemeController({ storage, media, root, events }) {
  let mode = 'system'
  try {
    mode = validTheme(storage?.getItem(THEME_KEY))
  } catch {
    /* 隐私模式可能禁用存储。 */
  }
  const subscribers = new Set()

  /** 同时维护 CSS 暗色类、语义属性和原生控件色彩方案。 */
  function apply() {
    const resolved = resolveTheme(mode, media.matches)
    root.classList.toggle('dark', resolved === 'dark')
    root.dataset.theme = mode
    root.style.colorScheme = resolved
    for (const subscriber of subscribers) subscriber({ mode, resolved })
  }

  /** 保存显式选择；存储失败不会阻止本次外观切换。 */
  function setMode(value) {
    mode = validTheme(value)
    try {
      storage?.setItem(THEME_KEY, mode)
    } catch {
      /* 当前标签仍保持选择。 */
    }
    apply()
  }

  /** 其他标签修改或清除偏好时，同步本页；其他存储键变化不触发主题更新。 */
  function syncStorage(event) {
    if (event.key !== THEME_KEY && event.key !== null) return
    mode = validTheme(event.newValue)
    apply()
  }

  /** 订阅主题状态，返回取消订阅函数，避免组件持有过期回调。 */
  function subscribe(callback) {
    subscribers.add(callback)
    return () => subscribers.delete(callback)
  }

  /** 释放全局监听及订阅，外观本身保留在文档根节点。 */
  function dispose() {
    media.removeEventListener('change', apply)
    events.removeEventListener('storage', syncStorage)
    subscribers.clear()
  }

  media.addEventListener('change', apply)
  events.addEventListener('storage', syncStorage)
  apply()
  return {
    get mode() {
      return mode
    },
    get resolved() {
      return resolveTheme(mode, media.matches)
    },
    setMode,
    subscribe,
    dispose,
  }
}
