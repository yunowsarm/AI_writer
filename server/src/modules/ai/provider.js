/** DeepSeek 适配层：只解析最终文本增量，不向前端发送密钥或思考过程。 */
import { AppError, ensure } from '../../shared/errors.js'
import { providerFetch } from '../settings/transport.js'

/**
 * 将上游字节流按行解码为 SSE data 对象，并在 [DONE] 时结束。
 * 保留跨网络分块的半行与 UTF-8 字符状态，同时处理无末尾换行的最后一条记录。
 */
export async function* parseSSE(body) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trimEnd()
      buffer = buffer.slice(end + 1)
      if (line.startsWith('data:')) {
        const raw = line.slice(5).trim()
        if (raw === '[DONE]') return
        if (raw) yield JSON.parse(raw)
      }
    }
  }
  buffer += decoder.decode()
  if (buffer.trim().startsWith('data:')) {
    const raw = buffer.trim().slice(5).trim()
    if (raw && raw !== '[DONE]') yield JSON.parse(raw)
  }
}

/**
 * 请求 DeepSeek 流式补全，逐段回调正文与用量，并返回完整正文。
 * 合并用户取消和超时信号；仅输出 content，不向前端传递思考过程或上游凭据。
 * 必须收到 stop 结束标记且正文非空才成功，截断或连接中断转换为可识别业务错误。
 */
export async function streamCompletion(messages, { signal, onDelta, onUsage, settings, maxTokens = 8192, temperature } = {}) {
  ensure(settings?.key, 503, 'AI_NOT_CONFIGURED', '请先在个人 API 配置页面填写你自己的 DeepSeek Key')
  const timeout = AbortSignal.timeout(settings.timeout)
  const combined = AbortSignal.any([signal || new AbortController().signal, timeout])
  const anthropic = settings.apiFormat === 'anthropic-messages'
  let response
  try {
    response = await providerFetch(settings, anthropic ? '/messages' : '/chat/completions', {
      method: 'POST',
      headers: anthropic
        ? { 'x-api-key': settings.key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
        : { Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(
        anthropic
          ? {
              model: settings.model,
              stream: true,
              max_tokens: maxTokens,
              ...(temperature === undefined ? {} : { temperature }),
              system: messages
                .filter((m) => m.role === 'system')
                .map((m) => m.content)
                .join('\n'),
              messages: messages.filter((m) => m.role !== 'system')
            }
          : {
              model: settings.model,
              messages,
              stream: true,
              stream_options: { include_usage: true },
              ...(new URL(settings.baseUrl).hostname === 'api.deepseek.com' ? { thinking: { type: 'disabled' } } : {}),
              max_tokens: maxTokens,
              ...(temperature === undefined ? {} : { temperature })
            }
      ),
      signal: combined
    })
  } catch (e) {
    if (signal?.aborted || e.status) throw e
    throw new AppError(502, 'AI_CONNECTION_FAILED', '模型服务连接失败或超时，请稍后重试')
  }
  if (!response.ok) {
    const code = response.status === 401 ? 'AI_AUTH_FAILED' : response.status === 429 ? 'AI_RATE_LIMIT' : 'AI_UPSTREAM_ERROR'
    await response.body?.cancel()
    throw new AppError(502, code, response.status === 401 ? 'API Key 无效，请检查该供应商配置' : response.status === 429 ? '模型服务额度或请求频率受限' : '模型服务返回错误，请稍后重试')
  }
  let output = '',
    finished = false
  let anthropicUsage = {},
    anthropicStopped = false
  try {
    for await (const event of parseSSE(response.body)) {
      if (anthropic) {
        ensure(event.type !== 'error', 502, 'AI_UPSTREAM_ERROR', '模型服务流式响应出错')
        if (event.type === 'message_start') anthropicUsage = { ...event.message?.usage }
        if (event.type === 'message_delta') {
          anthropicUsage = { ...anthropicUsage, ...event.usage }
          ensure(['end_turn', 'stop_sequence'].includes(event.delta?.stop_reason), 502, 'AI_OUTPUT_TRUNCATED', '模型输出未完整结束，请缩短内容重试')
          anthropicStopped = true
        }
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          output += event.delta.text
          await onDelta?.(event.delta.text)
        }
        if (event.type === 'message_stop') {
          const { input_tokens: input, output_tokens: out, cache_read_input_tokens: hit, cache_creation_input_tokens: created } = anthropicUsage
          await onUsage?.({
            prompt_tokens: input == null ? null : input + (hit || 0) + (created || 0),
            completion_tokens: out,
            total_tokens: input == null || out == null ? null : input + (hit || 0) + (created || 0) + out
          })
          finished = anthropicStopped
        }
        continue
      }
      if (event.usage) await onUsage?.(event.usage)
      const choice = event.choices?.[0]
      const text = choice?.delta?.content
      if (text) {
        output += text
        await onDelta?.(text)
      }
      if (choice?.finish_reason) {
        ensure(choice.finish_reason === 'stop', 502, 'AI_OUTPUT_TRUNCATED', '模型输出未完整结束，请缩短单集时长后重试')
        finished = true
      }
    }
  } catch (e) {
    if (e.status || signal?.aborted) throw e
    throw new AppError(502, 'AI_STREAM_INTERRUPTED', '生成连接中断，已保留完成的分集')
  }
  ensure(output.trim() && finished, 502, 'AI_EMPTY_RESULT', '模型未返回完整正文，请重试')
  return output
}
