/** 个人供应商服务：供应商与模型分层管理，任何查询都由会话用户限定归属。 */
import { z } from 'zod'
import { q, transaction } from '../../db/index.js'
import { config } from '../../config.js'
import { ensure } from '../../shared/errors.js'
import { openApiKey, sealApiKey } from './secrets.js'
import { normalizeBaseUrl, providerFetch } from './transport.js'

export const selectionSchema = z.object({ providerId: z.number().int().positive(), model: z.string().trim().min(1).max(100) })
export const providerInput = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().trim().max(500),
  apiFormat: z.enum(['openai-chat', 'anthropic-messages']),
  apiKey: z.string().trim().max(512).optional(),
  enabled: z.boolean().default(true),
  timeout: z.number().int().min(10000).max(600000).default(180000),
  models: z
    .array(z.object({ model: z.string().trim().min(1).max(100), label: z.string().trim().min(1).max(100), enabled: z.boolean() }))
    .min(1)
    .max(100)
    .refine((rows) => new Set(rows.map((row) => row.model)).size === rows.length, '模型 ID 不可重复')
})

/** 首次读取时将旧单配置迁成一条供应商；锁定用户行防止并发重复迁入。 */
export async function importLegacyProvider(userId) {
  if (!userId) return
  await transaction(async (db) => {
    await q('SELECT id FROM users WHERE id=? FOR UPDATE', [userId], db)
    const existing = await q('SELECT id FROM ai_providers WHERE user_id=? LIMIT 1', [userId], db)
    if (existing.length) return
    const [row] = await q('SELECT * FROM user_ai_settings WHERE user_id=?', [userId], db)
    if (!row) return
    const result = await q(
      'INSERT INTO ai_providers(user_id,name,base_url,api_format,key_encrypted,timeout_ms,legacy) VALUES(?,?,?,?,?,?,TRUE)',
      [userId, 'DeepSeek', config.ai.baseUrl, 'openai-chat', row.key_encrypted, row.timeout_ms],
      db
    )
    await q('INSERT INTO ai_provider_models(provider_id,model,label,enabled) VALUES(?,?,?,TRUE)', [result.insertId, row.model, row.model], db)
  })
}

/** 对外仅提供密钥状态，绝不将加密密钥或明文密钥送回浏览器。 */
export async function listProviders(userId) {
  if (!userId) return []
  await importLegacyProvider(userId)
  const rows = await q('SELECT id,name,base_url,api_format,enabled,timeout_ms,key_encrypted IS NOT NULL key_configured FROM ai_providers WHERE user_id=? ORDER BY id', [userId])
  const models = await q('SELECT m.* FROM ai_provider_models m JOIN ai_providers p ON p.id=m.provider_id WHERE p.user_id=? ORDER BY m.id', [userId])
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiFormat: row.api_format,
    enabled: Boolean(row.enabled),
    timeout: row.timeout_ms,
    keyConfigured: Boolean(row.key_configured),
    models: models.filter((m) => m.provider_id === row.id).map((m) => ({ model: m.model, label: m.label, enabled: Boolean(m.enabled) }))
  }))
}

/** 按选项解析配置；显式选择停用或他人的模型时直接拒绝，不能静默换模型。 */
export async function resolveProvider(userId, selection) {
  const rows = await listProviders(userId)
  const provider = selection ? rows.find((p) => p.id === selection.providerId) : rows.find((p) => p.enabled && p.keyConfigured && p.models.some((m) => m.enabled))
  if (!provider && !selection) return { baseUrl: config.ai.baseUrl, model: config.ai.model, timeout: config.ai.timeout, key: '' }
  ensure(provider, 404, 'AI_PROVIDER_NOT_FOUND', '供应商不存在或无权访问')
  ensure(provider.enabled, 400, 'AI_PROVIDER_DISABLED', '该供应商已停用')
  const model = selection ? provider.models.find((m) => m.model === selection.model) : provider.models.find((m) => m.enabled)
  ensure(model?.enabled, 400, 'AI_MODEL_DISABLED', '模型不存在或已停用')
  const [secret] = await q('SELECT key_encrypted,legacy FROM ai_providers WHERE id=? AND user_id=?', [provider.id, userId])
  ensure(secret, 404, 'AI_PROVIDER_NOT_FOUND', '供应商配置已变化，请重新选择模型')
  return {
    providerId: provider.id,
    providerName: provider.name,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    model: model.model,
    timeout: provider.timeout,
    key: await openApiKey(userId, secret.key_encrypted),
    legacy: Boolean(secret.legacy)
  }
}

/** 保存整条供应商及模型清单；空 Key 仅保留同一供应商已有密钥。 */
export async function saveProvider(userId, id, input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  await transaction(async (db) => {
    await q('SELECT id FROM users WHERE id=? FOR UPDATE', [userId], db)
    let current = null
    if (id) {
      ;[current] = await q('SELECT * FROM ai_providers WHERE id=? AND user_id=? FOR UPDATE', [id, userId], db)
      ensure(current, 404, 'AI_PROVIDER_NOT_FOUND', '供应商不存在或无权访问')
    } else {
      const [count] = await q('SELECT COUNT(*) n FROM ai_providers WHERE user_id=?', [userId], db)
      ensure(count.n < 20, 400, 'AI_PROVIDER_LIMIT', '最多保存 20 个供应商')
    }
    // 修改地址必须重新填写密钥，避免旧密钥被无意发送到新的服务。
    ensure(!current || current.base_url === baseUrl || input.apiKey, 400, 'API_KEY_REQUIRED', '修改服务地址后，请重新填写该供应商的 Key')
    const encrypted = input.apiKey ? await sealApiKey(userId, input.apiKey) : current?.key_encrypted
    ensure(encrypted, 400, 'API_KEY_REQUIRED', '请填写该供应商的 API Key')
    if (current) {
      await q(
        'UPDATE ai_providers SET name=?,base_url=?,api_format=?,key_encrypted=?,enabled=?,timeout_ms=?,legacy=FALSE WHERE id=? AND user_id=?',
        [input.name, baseUrl, input.apiFormat, encrypted, input.enabled, input.timeout, id, userId],
        db
      )
      await q('DELETE FROM ai_provider_models WHERE provider_id=?', [id], db)
    } else {
      const result = await q(
        'INSERT INTO ai_providers(user_id,name,base_url,api_format,key_encrypted,enabled,timeout_ms) VALUES(?,?,?,?,?,?,?)',
        [userId, input.name, baseUrl, input.apiFormat, encrypted, input.enabled, input.timeout],
        db
      )
      id = result.insertId
    }
    for (const model of input.models) await q('INSERT INTO ai_provider_models(provider_id,model,label,enabled) VALUES(?,?,?,?)', [id, model.model, model.label, model.enabled], db)
    // 一旦用户管理新结构，旧单配置不再成为可重新导入的来源。
    await q('DELETE FROM user_ai_settings WHERE user_id=?', [userId], db)
  })
  return (await listProviders(userId)).find((p) => p.id === id)
}

/** 删除仅限本人供应商；模型随外键级联删除，历史用量保留来源快照。 */
export async function deleteProvider(userId, id) {
  await transaction(async (db) => {
    const result = await q('DELETE FROM ai_providers WHERE id=? AND user_id=?', [id, userId], db)
    ensure(result.affectedRows, 404, 'AI_PROVIDER_NOT_FOUND', '供应商不存在或无权访问')
    await q('DELETE FROM user_ai_settings WHERE user_id=?', [userId], db)
  })
}

/** 读取模型列表用于连接测试；不生成内容，不修改已保存的模型启停状态。 */
export async function testProvider(userId, id, input) {
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  let key = input.apiKey
  if (!key && id) {
    const [row] = await q('SELECT * FROM ai_providers WHERE id=? AND user_id=?', [id, userId])
    ensure(row, 404, 'AI_PROVIDER_NOT_FOUND', '供应商不存在或无权访问')
    ensure(row.base_url === baseUrl, 400, 'API_KEY_REQUIRED', '修改服务地址后，请重新填写 Key')
    key = await openApiKey(userId, row.key_encrypted)
  }
  ensure(key, 400, 'API_KEY_REQUIRED', '请填写 API Key 后测试')
  const headers = input.apiFormat === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: 'Bearer ' + key }
  let response
  try {
    response = await providerFetch({ baseUrl }, '/models', { headers, signal: AbortSignal.timeout(15000) })
  } catch (e) {
    if (e.status) throw e
    ensure(false, 502, 'AI_CONNECTION_FAILED', '连接失败，请检查地址、网络与 API 格式')
  }
  ensure(response.ok, 502, response.status === 401 ? 'AI_AUTH_FAILED' : 'AI_CONNECTION_FAILED', '模型列表获取失败，请检查 Key；不支持列表接口的供应商可手动添加模型')
  let body
  try {
    body = await response.json()
  } catch {
    ensure(false, 502, 'AI_RESPONSE_INVALID', '模型列表响应无效')
  }
  ensure(Array.isArray(body.data), 502, 'AI_RESPONSE_INVALID', '模型列表响应无效')
  return {
    ok: true,
    models: body.data
      .filter((m) => typeof m.id === 'string' && m.id.length <= 100)
      .slice(0, 100)
      .map((m) => m.id),
    message: '连接成功，可将返回模型添加到供应商'
  }
}
