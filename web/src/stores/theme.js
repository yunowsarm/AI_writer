/** 主题仓库：将独立主题控制器映射到 Vue 状态，供所有页面共用。 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { createThemeController } from '../shared/theme'

export const useTheme = defineStore('theme', () => {
  let storage
  try {
    storage = window.localStorage
  } catch {
    /* 存储受限不影响本页主题。 */
  }
  const controller = createThemeController({
    storage,
    media: window.matchMedia('(prefers-color-scheme: dark)'),
    root: document.documentElement,
    events: window,
  })
  const mode = ref(controller.mode),
    resolved = ref(controller.resolved)
  controller.subscribe((state) => {
    mode.value = state.mode
    resolved.value = state.resolved
  })
  return { mode, resolved, setMode: controller.setMode, dispose: controller.dispose }
})
