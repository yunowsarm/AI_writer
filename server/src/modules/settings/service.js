/** 个人 AI 配置：按当前用户查询 MySQL，密钥加密保存，不回退到公共密钥。 */
import { readFile, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { config } from '../../config.js'
import { q } from '../../db/index.js'
import { AppError, ensure } from '../../shared/errors.js'
import { sealApiKey, openApiKey } from './secrets.js'
import { listProviders, resolveProvider } from './providers.js'
const file = process.env.AI_SETTINGS_PATH || fileURLToPath(new URL('../../../../.local/ai-settings.json', import.meta.url))
const queues = new Map()
export const settingsInput = z.object({
  model: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-zA-Z0-9._:-]+$/),
  timeout: z.number().int().min(10000).max(600000),
  apiKey: z.string().trim().max(512).optional()
})
const storedSchema = z.object({
  key: z.string().min(1).max(512).nullable(),
  model: z.string().min(1).max(100),
  timeout: z.number().int().min(10000).max(600000)
})

/** 读取本人配置；即使是管理员，也只能通过此边界读取自己账号的配置。 */
async function storedSettings(userId) {
  if (!userId) return null
  return (await q('SELECT * FROM user_ai_settings WHERE user_id=?', [userId]))[0] || null
}

/** 对外仅返回模型、超时和是否配置密钥，不解密或回显密钥。 */
export async function settingsView(userId) {
  const providers = await listProviders(userId)
  const usable = providers.find((p) => p.enabled && p.keyConfigured && p.models.some((m) => m.enabled))
  return {
    model: usable?.models.find((m) => m.enabled)?.model || config.ai.model,
    timeout: usable?.timeout || config.ai.timeout,
    baseUrl: usable?.baseUrl || config.ai.baseUrl,
    keyConfigured: !!usable,
    source: providers.length ? 'personal' : 'unconfigured',
    providers
  }
}

/** 仅供服务端生成或连接测试：解析当前用户的有效模型配置，不使用环境公共 Key。 */
export async function getAiSettings(userId, selection) {
  return resolveProvider(userId, selection)
}

/**
 * 将旧共享页面配置归还最后一次保存它的用户，再归档旧文件，避免重新导入已删除的配置。
 * 无法由审计记录确认归属时不分配密钥；环境 Key 也不会自动分享给任何新用户。
 */
export async function loadAiSettings() {
  let legacy
  try {
    legacy = storedSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  } catch (e) {
    if (e.code === 'ENOENT') return
    throw new Error('旧 API 配置文件无法读取，请检查 .local/ai-settings.json')
  }
  const [owner] = await q("SELECT actor_id FROM audit_logs WHERE action='ai.settings.save' ORDER BY id DESC LIMIT 1")
  if (!owner?.actor_id) return
  await q('INSERT IGNORE INTO user_ai_settings(user_id,key_encrypted,model,timeout_ms) VALUES(?,?,?,?)', [owner.actor_id, await sealApiKey(owner.actor_id, legacy.key), legacy.model, legacy.timeout])
  await rename(file, file + '.legacy')
}

/** 同一用户的保存与清除串行执行，不同用户的配置互不阻塞。 */
function serialize(userId, work) {
  const next = (queues.get(userId) || Promise.resolve()).then(work)
  const tail = next.catch(() => {})
  queues.set(userId, tail)
  tail.finally(() => {
    if (queues.get(userId) === tail) queues.delete(userId)
  })
  return next
}

/** 保存当前用户配置：留空只保留本人的旧密钥，新用户必须填写自己的 Key。 */
export function saveAiSettings(userId, input) {
  return serialize(userId, async () => {
    const current = await storedSettings(userId)
    const encrypted = input.apiKey ? await sealApiKey(userId, input.apiKey) : current?.key_encrypted
    ensure(encrypted, 400, 'API_KEY_REQUIRED', '请先填写你自己的 DeepSeek API Key')
    await q(
      'INSERT INTO user_ai_settings(user_id,key_encrypted,model,timeout_ms) VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE key_encrypted=VALUES(key_encrypted),model=VALUES(model),timeout_ms=VALUES(timeout_ms)',
      [userId, encrypted, input.model, input.timeout]
    )
    // 兼容旧单配置接口：更新已迁移的默认供应商，不影响其他供应商。
    const [provider] = await q('SELECT id FROM ai_providers WHERE user_id=? AND legacy=TRUE ORDER BY id LIMIT 1', [userId])
    if (provider) {
      await q('UPDATE ai_providers SET key_encrypted=?,timeout_ms=?,enabled=TRUE WHERE id=?', [encrypted, input.timeout, provider.id])
      await q('DELETE FROM ai_provider_models WHERE provider_id=?', [provider.id])
      await q('INSERT INTO ai_provider_models(provider_id,model,label,enabled) VALUES(?,?,?,TRUE)', [provider.id, input.model, input.model])
    }
    return settingsView(userId)
  })
}

/** 只清除本人的密钥和设置；清除后 AI 不可用，绝不回退到他人或环境密钥。 */
export function resetAiSettings(userId) {
  return serialize(userId, async () => {
    await q('DELETE FROM user_ai_settings WHERE user_id=?', [userId])
    await q('DELETE FROM ai_providers WHERE user_id=?', [userId])
    return settingsView(userId)
  })
}
/**
 * 使用当前或待填写密钥请求模型列表，检查连通性和模型可用性。
 * 不保存配置、不生成剧本；拒绝重定向，最长等待十五秒，返回信息不包含密钥。
 */
export async function testAiConnection(userId, input) {
  const settings = {
    ...(await getAiSettings(userId)),
    model: input.model,
    timeout: input.timeout
  }
  if (input.apiKey) settings.key = input.apiKey
  ensure(settings.key, 503, 'AI_NOT_CONFIGURED', '请先填写 API Key')
  let response
  try {
    response = await fetch(settings.baseUrl.replace(/\/$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + settings.key },
      signal: AbortSignal.timeout(Math.min(settings.timeout, 15000)),
      redirect: 'error'
    })
  } catch {
    throw new AppError(502, 'AI_CONNECTION_FAILED', '无法连接 DeepSeek，请检查网络后重试')
  }
  ensure(response.ok, 502, response.status === 401 ? 'AI_AUTH_FAILED' : 'AI_CONNECTION_FAILED', response.status === 401 ? 'API Key 无效，请检查后重试' : '模型服务暂不可用，请稍后重试')
  let body
  try {
    body = await response.json()
  } catch {
    throw new AppError(502, 'AI_RESPONSE_INVALID', '模型列表响应无效')
  }
  ensure(Array.isArray(body.data), 502, 'AI_RESPONSE_INVALID', '模型列表响应无效')
  const models = body.data
    .map((x) => x.id)
    .filter((x) => typeof x === 'string' && x.length <= 100)
    .slice(0, 100)
  return {
    ok: true,
    models,
    modelAvailable: models.includes(settings.model),
    message: models.includes(settings.model) ? '连接成功，当前模型可用' : '连接成功，请从返回列表选择可用模型'
  }
}
