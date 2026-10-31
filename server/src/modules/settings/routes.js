/** 个人 API 配置接口：用户归属来自会话，拒绝客户端指定其他用户。 */
import { Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import { z } from 'zod'
import { idSchema } from '../../shared/validation.js'
import { listProviders, providerInput, saveProvider, deleteProvider, testProvider } from './providers.js'
import { requireUser } from '../auth/service.js'
import { q } from '../../db/index.js'
import { ensure } from '../../shared/errors.js'
import { hasActiveJobs } from '../ai/routes.js'
import { settingsInput, settingsView, saveAiSettings, resetAiSettings, testAiConnection } from './service.js'
export const settingsRouter = Router()
settingsRouter.use(requireUser)

/** GET /api/me/settings/providers：列出本人供应商和模型；只返回密钥配置状态。 */
settingsRouter.get('/providers', async (req, res) => res.set('Cache-Control', 'no-store').json(await listProviders(req.user.id)))

/** POST /api/me/settings/providers：新增供应商及其模型，运行中任务禁止变更配置。 */
settingsRouter.post('/providers', async (req, res) => {
  ensure(!hasActiveJobs(req.user.id), 409, 'AI_JOB_ACTIVE', '请先结束你的 AI 任务')
  res.status(201).json(await saveProvider(req.user.id, null, providerInput.parse(req.body)))
})

/** PUT /api/me/settings/providers/:id：替换本人供应商资料与模型清单，空 Key 保留旧值。 */
settingsRouter.put('/providers/:id', async (req, res) => {
  ensure(!hasActiveJobs(req.user.id), 409, 'AI_JOB_ACTIVE', '请先结束你的 AI 任务')
  res.json(await saveProvider(req.user.id, idSchema.parse(req.params.id), providerInput.parse(req.body)))
})

/** DELETE /api/me/settings/providers/:id：删除本人指定供应商，历史调用记录仍保留。 */
settingsRouter.delete('/providers/:id', async (req, res) => {
  ensure(!hasActiveJobs(req.user.id), 409, 'AI_JOB_ACTIVE', '请先结束你的 AI 任务')
  await deleteProvider(req.user.id, idSchema.parse(req.params.id))
  res.json({ ok: true })
})

/** POST /api/me/settings/providers/test：测试草稿或已保存供应商，返回可导入的模型 ID。 */
settingsRouter.post('/providers/test', rateLimit({ windowMs: 60000, limit: 6, keyGenerator: (req) => String(req.user.id) }), async (req, res) => {
  const input = providerInput.extend({ id: z.number().int().positive().optional(), models: providerInput.shape.models.optional() }).parse(req.body)
  res.json(await testProvider(req.user.id, input.id, input))
})

/**
 * GET /api/me/settings/ai
 * 用途：查询本人的 AI 配置及密钥状态。
 * 权限：登录用户，仅本人；响应禁止缓存。
 * 入参：无。
 * 返回：模型、超时、服务地址及密钥配置状态，不返回密钥。
 */
settingsRouter.get('/ai', async (req, res) => {
  res.set('Cache-Control', 'no-store')
  res.json(await settingsView(req.user.id))
})

/**
 * PUT /api/me/settings/ai
 * 用途：持久化页面 AI 配置并立即生效，空密钥保留原设置。
 * 权限：登录用户，仅本人；本人的 AI 任务运行中时拒绝修改。
 * 入参：Body：model、timeout（10000～600000 毫秒），可选 apiKey。
 * 返回：不含密钥的当前配置视图。
 */
settingsRouter.put('/ai', async (req, res) => {
  const input = settingsInput.parse(req.body)
  ensure(!hasActiveJobs(req.user.id), 409, 'AI_JOB_ACTIVE', '你的 AI 任务正在运行，请结束后再修改配置')
  const result = await saveAiSettings(req.user.id, input)
  await q('INSERT INTO audit_logs(actor_id,action,detail) VALUES(?,?,?)', [req.user.id, 'ai.settings.save', '模型：' + input.model])
  res.json(result)
})

/**
 * DELETE /api/me/settings/ai
 * 用途：清除本人的密钥和配置，不回退到公共 Key。
 * 权限：登录用户，仅本人；本人的 AI 任务运行中时拒绝清除。
 * 入参：无。
 * 返回：未配置状态，不含密钥。
 */
settingsRouter.delete('/ai', async (req, res) => {
  ensure(!hasActiveJobs(req.user.id), 409, 'AI_JOB_ACTIVE', '你的 AI 任务正在运行，请结束后再清除配置')
  const result = await resetAiSettings(req.user.id)
  await q('INSERT INTO audit_logs(actor_id,action,detail) VALUES(?,?,?)', [req.user.id, 'ai.settings.reset', '清除个人 API 配置'])
  res.json(result)
})

/**
 * POST /api/me/settings/ai/test
 * 用途：使用待提交配置请求模型列表，仅测试连接，不保存。
 * 权限：登录用户，仅使用本人的密钥，每分钟最多 6 次。
 * 入参：Body：model、timeout，可选 apiKey；空密钥仅使用本人保存的密钥。
 * 返回：可用模型列表、当前模型是否可用及提示消息。
 */
settingsRouter.post(
  '/ai/test',
  rateLimit({
    windowMs: 60000,
    limit: 6,
    keyGenerator: (req) => String(req.user.id),
    message: { code: 'TEST_RATE_LIMIT', message: '连接测试过于频繁，请稍后重试' }
  }),
  async (req, res) => res.json(await testAiConnection(req.user.id, settingsInput.parse(req.body)))
)
