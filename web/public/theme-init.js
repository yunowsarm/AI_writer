/* 在样式与应用加载前设置根节点主题，避免已选暗色时先闪出明亮页面。 */
;(() => {
  let mode = 'system'
  try {
    const saved = localStorage.getItem('script-studio:theme')
    if (['light', 'dark', 'system'].includes(saved)) mode = saved
  } catch {
    /* 浏览器限制存储时仍遵循系统主题。 */
  }
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
})()
