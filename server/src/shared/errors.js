/** 统一业务错误，避免把数据库或上游凭据错误直接返回浏览器。 */
export class AppError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * 业务断言不满足时抛出带 HTTP 状态、错误码和提示消息的 AppError。
 */
export function ensure(ok, status, code, message) {
  if (!ok) throw new AppError(status, code, message)
}

/** 数据库连接类故障与模型故障分别提示，避免把数据库离线误报为 AI 生成异常。 */
export function isDatabaseUnavailable(error) {
  return ['ECONNREFUSED', 'PROTOCOL_CONNECTION_LOST', 'ER_SERVER_SHUTDOWN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(error?.code)
}

/**
 * 统一处理参数校验、唯一键冲突、体积超限及业务异常。
 * 响应附带请求标识；未知异常隐藏内部错误详情，已发送响应头时交给后续处理器。
 */
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)
  if (err.name === 'ZodError')
    return res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: '输入内容不符合要求',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      requestId: req.requestId
    })
  if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ code: 'DUPLICATE', message: '记录已存在，请勿重复提交', requestId: req.requestId })
  if (err.type === 'entity.too.large') return res.status(413).json({ code: 'TOO_LARGE', message: '提交内容过大' })
  if (isDatabaseUnavailable(err)) return res.status(503).json({ code: 'DATABASE_UNAVAILABLE', message: '数据库暂时无法连接，请恢复数据库后重试', requestId: req.requestId })
  if (!err.status) console.error(`[${req.requestId}]`, err.code || err.name)
  res.status(err.status || 500).json({
    code: err.status ? err.code : 'INTERNAL_ERROR',
    message: err.status ? err.message : '服务暂时不可用，请稍后重试',
    requestId: req.requestId
  })
}
