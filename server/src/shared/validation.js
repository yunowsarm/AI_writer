/** 请求参数 schema：模块复用领域约束，拒绝无界长度和无效状态。 */
import { z } from 'zod'
export const idSchema = z.coerce.number().int().positive()
export const genre = z.enum(['逆袭', '复仇', '甜宠', '家庭', '悬疑', '都市'])
export const paramsSchema = z.object({
  theme: z.string().trim().min(2).max(1000),
  people: z.string().max(3000).default(''),
  background: z.string().max(3000).default(''),
  style: genre,
  // style 是剧本库分类题材；styleNote 用于补充用户自定义的叙事与表达风格。
  styleNote: z.string().trim().max(1000).default(''),
  episodes: z.coerce.number().int().min(1).max(80),
  duration: z.coerce.number().int().min(1).max(10),
  twist: z.string().max(3000).default('')
})
export const contentSchema = z.object({
  document: z.any().nullable().optional(),
  html: z.string().max(500000),
  text: z.string().max(200000),
  revision: z.number().int().positive(),
  title: z.string().trim().min(1).max(120),
  reason: z.string().max(80).default('自动保存')
})

/**
 * 校验通用分页、搜索和排序参数，并计算数据库查询偏移量。
 * 页大小限制为 1～60，页码从 1 开始；后续 SQL 仅插入已校验的数值。
 */
export function paging(query) {
  const schema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce.number().int().min(1).max(60).default(12),
    q: z.string().max(100).default(''),
    genre: z.union([genre, z.literal('')]).default(''),
    sort: z.enum(['recent', 'hot']).default('recent')
  })
  const v = schema.parse(query)
  return { ...v, offset: (v.page - 1) * v.size }
}
