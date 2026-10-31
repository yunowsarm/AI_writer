/** 人民币展示统一四舍五入为两位；汇总使用未舍入金额，避免逐条四舍五入的累计偏差。 */
export const cny = (value) => (value == null || !Number.isFinite(Number(value)) ? '—' : '¥' + (Math.round((Number(value) + Number.EPSILON) * 100) / 100).toFixed(2))

/** 同一显示精度下的相同峰谷价合并，避免出现“¥0.00 – ¥0.00”。 */
export function cnyRange(low, high) {
  if (low == null || high == null) return '—'
  const a = cny(low),
    b = cny(high)
  return a === b ? a : a + ' – ' + b
}
