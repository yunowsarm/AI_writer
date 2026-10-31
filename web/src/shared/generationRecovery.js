/** 按实际保存的集号判断进度，不能用最大集号或总行数代替完成数。 */
export function savedGenerationProgress(script) {
  const target = Number(script.config?.episodes || 0)
  const numbers = new Set(script.episodes.map((episode) => Number(episode.episode_no)).filter((n) => Number.isInteger(n) && n >= 1 && n <= target))
  return { completed: numbers.size, target, done: target > 0 && numbers.size === target }
}
