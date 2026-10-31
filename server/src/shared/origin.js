/** 请求来源边界：生产精确匹配站点；本地开发仅兼容明确端口上的回环地址。 */
import { AppError } from './errors.js'

/**
 * 根据服务端配置构建允许来源，不信任请求中的 Host 或代理转发头。
 * 开发环境的 HTTP 回环站点支持前端端口及 Express 页面端口；不放行任意本机端口。
 */
export function allowedOrigins(settings) {
  const origins = new Set([settings.origin])
  if (settings.production) return origins
  let site
  try {
    site = new URL(settings.origin)
  } catch {
    return origins
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]']
  if (site.protocol !== 'http:' || !loopback.includes(site.hostname)) return origins
  for (const hostname of loopback) {
    const frontend = new URL(site.origin)
    frontend.hostname = hostname
    origins.add(frontend.origin)
    const backend = new URL(`http://${hostname}`)
    backend.port = String(settings.port)
    origins.add(backend.origin)
  }
  return origins
}

/**
 * 校验浏览器写请求的 Origin；读取请求及无 Origin 的非浏览器调用维持原有行为。
 * 白名单在应用创建时生成，配置变化后由开发启动器重新创建后端应用。
 */
export function originGuard(settings) {
  const origins = allowedOrigins(settings)
  return (req, res, next) => {
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin &&
      !origins.has(req.headers.origin)
    )
      return next(new AppError(403, 'ORIGIN_FORBIDDEN', '不允许的请求来源'))
    next()
  }
}
