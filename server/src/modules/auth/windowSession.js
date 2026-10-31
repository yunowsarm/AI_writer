/** 窗口会话作用域：浏览器只持有窗口编号，认证令牌仍在 HttpOnly Cookie 中。 */
import { z } from 'zod'
export const windowScope = z.string().regex(/^[a-f0-9]{32}$/)

export const sessionCookie = (scope) => (scope ? 'mujian_session_' + windowScope.parse(scope) : 'mujian_session')

/** 有窗口标识时绝不回退共享 Cookie，防止新窗口或失效会话串到其他账号。 */
export function sessionScope(req) {
  const path = req.originalUrl?.split('?')[0] || req.path
  const header = req.get('X-Window-Session')
  if (header !== undefined) return windowScope.parse(header)
  if (path === '/api/auth/wechat' && req.query.window) return windowScope.parse(req.query.window)
  if (path === '/api/auth/wechat/callback' && typeof req.query.state === 'string' && /^[a-f0-9]{64}$/.test(req.query.state)) {
    const scope = req.cookies?.['mujian_wechat_' + req.query.state]
    if (scope) return windowScope.parse(scope)
  }
  return ''
}
