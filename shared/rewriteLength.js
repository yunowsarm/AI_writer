/** 改写篇幅策略：前后端共用，按实际原文长度和操作类型计算建议范围。 */
export function rewriteBudget(text, operation, targetWords) {
  const source = Array.from(text.replace(/\s/g, '')).length
  const ratios = { expand: [1.3, 2], shorten: [0.45, 0.8], continue: [0.4, 1], style: [0.8, 1.2], regenerate: [0.8, 1.2] }
  const [low, high] = ratios[operation] || ratios.regenerate
  const explicit = Number.isInteger(targetWords) && targetWords >= 10 && targetWords <= 12000
  const target = explicit ? targetWords : Math.max(10, Math.min(12000, Math.round((source * (low + high)) / 2)))
  const min = explicit ? Math.round(target * 0.8) : Math.min(12000, Math.max(5, Math.round(source * low)))
  const max = explicit ? Math.min(15000, Math.round(target * 1.2)) : Math.min(15000, Math.max(operation === 'shorten' ? 5 : operation === 'continue' ? 80 : 30, Math.round(source * high)))
  return { source, target, min: Math.min(min, max), max, explicit }
}
