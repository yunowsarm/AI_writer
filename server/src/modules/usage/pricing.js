/**
 * DeepSeek 官方模型价格表（人民币和美元 / 1M Token）。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/，价格会随官方调整而变化。
 * 页面直接展示官方人民币计价的峰谷区间，美元字段仅为兼容旧接口保留。
 */
export const pricingUpdatedAt = '2026-10-27'

// 官方中文价格表，人民币 / 百万 Token；直接按人民币报价，不涉及汇率换算。
const yuanPrices = {
  'deepseek-flash': { offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }, peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 } },
  'deepseek-v4-pro': { offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 }, peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 } }
}

const officialPrices = {
  'deepseek-flash': {
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 }
  },
  'deepseek-v4-pro': {
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 }
  }
}

/**
 * 为已兼容的旧模型名归一到官方当前计费模型；未知模型不做臆测报价。
 */
function priceFor(model) {
  if (['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model)) return officialPrices['deepseek-flash']
  return officialPrices[model] || null
}

/**
 * 根据 API usage 中的缓存命中、缓存未命中与输出 Token 计算峰谷费用。
 * 三项任一缺失时返回 null，避免将历史请求按猜测的缓存比例收费。
 */
export function estimateCost({ model, cacheHitTokens, cacheMissTokens, completionTokens, providerBaseUrl }) {
  if (providerBaseUrl && !/^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(providerBaseUrl)) return null
  if ([cacheHitTokens, cacheMissTokens, completionTokens].some((value) => value === null || value === undefined)) return null
  const rates = priceFor(model)
  const values = [cacheHitTokens, cacheMissTokens, completionTokens].map(Number)
  if (!rates || values.some((value) => !Number.isFinite(value) || value < 0)) return null
  const amount = (rate) => (values[0] * rate.cacheHit + values[1] * rate.cacheMiss + values[2] * rate.output) / 1_000_000
  const cnyRates = yuanPrices[['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model) ? 'deepseek-flash' : model]
  return { offPeakUsd: amount(rates.offPeak), peakUsd: amount(rates.peak), offPeakCny: amount(cnyRates.offPeak), peakCny: amount(cnyRates.peak) }
}

/** 将服务器返回的费用保留足够精度，前端再按金额大小选择展示位数。 */
export const costValue = (value) => Math.round(value * 1e9) / 1e9
