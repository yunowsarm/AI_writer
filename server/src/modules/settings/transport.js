/** 供应商网络边界：只访问公开 HTTPS 地址，固定解析结果，禁止重定向和内网探测。 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import https from 'node:https'
import { config } from '../../config.js'
import { ensure } from '../../shared/errors.js'

/** 拒绝本机、私网、链路本地、保留地址及 IPv4 映射地址。 */
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || b === 2)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19, 51].includes(b)) ||
      (a === 203 && b === 0)
    )
  }
  // 新供应商仅接受全球单播 IPv6；映射地址、ULA 和链路本地地址不会进入请求。
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:db8:/i.test(address)
}

/** 验证可保存的 baseURL；API 版本路径由用户填写，接口路径由适配器追加。 */
export function normalizeBaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    ensure(false, 400, 'AI_URL_INVALID', '请填写完整的 HTTPS 服务地址')
  }
  ensure(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 400, 'AI_URL_INVALID', '服务地址须为 HTTPS，且不能包含账号、查询参数或片段')
  ensure(!isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.') && !url.hostname.endsWith('.local'), 400, 'AI_URL_PRIVATE', '请使用公开模型供应商的域名')
  return url.href.replace(/\/+$/, '')
}

/**
 * 使用校验后的 DNS 结果建立 TLS 连接，避免校验和实际请求之间发生 DNS 重绑定。
 * 仅兼容服务器原有本地测试地址；页面新增地址始终走公开 HTTPS 验证。
 */
export async function providerFetch(settings, path, options = {}) {
  const base = settings.baseUrl.replace(/\/+$/, '')
  if (settings.legacy && base === config.ai.baseUrl.replace(/\/+$/, '') && new URL(base).protocol === 'http:') {
    return fetch(base + path, { ...options, redirect: 'error' })
  }
  normalizeBaseUrl(base)
  const url = new URL(base + path)
  const addresses = await lookup(url.hostname, { all: true })
  ensure(addresses.length && addresses.every((item) => isPublicAddress(item.address)), 400, 'AI_URL_PRIVATE', '供应商地址不能指向本机或内网')
  const target = addresses[0]
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers,
        signal: options.signal,
        lookup: (_hostname, opts, callback) => (opts?.all ? callback(null, [target]) : callback(null, target.address, target.family))
      },
      (response) => {
        response.cancel = async () => response.destroy()
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode,
          body: response,
          json: async () => {
            let text = ''
            const decoder = new TextDecoder()
            for await (const chunk of response) {
              text += decoder.decode(chunk, { stream: true })
              ensure(text.length <= 2000000, 502, 'AI_RESPONSE_INVALID', '模型列表过大')
            }
            text += decoder.decode()
            return JSON.parse(text)
          }
        })
      }
    )
    request.on('error', reject)
    request.end(options.body)
  })
}
