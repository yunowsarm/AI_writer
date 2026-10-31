/** 随机故事设定：由用户选定模型填写全部创作参数，校验通过才交给页面使用。 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { paramsSchema } from '../../shared/validation.js'
import { trackedCompletion } from '../usage/service.js'
import { ensure } from '../../shared/errors.js'

const configurationSchema = z.object({
  title: z.string().trim().min(1).max(120),
  params: paramsSchema.extend({
    people: z.string().trim().min(2).max(3000),
    background: z.string().trim().min(2).max(3000),
    twist: z.string().trim().min(2).max(3000),
    styleNote: z.string().trim().min(2).max(1000)
  })
})

/** 一次模型调用生成独立创意；不创建剧本，不使用固定模板随机拼接。 */
export async function randomConfiguration(job) {
  const text = await trackedCompletion(
    job,
    [
      { role: 'system', content: '你是中文短剧策划。随机构思一个人物动机合理、冲突清晰、可拍摄的新故事。只输出有效JSON，不输出Markdown和解释。' },
      {
        role: 'user',
        content: `创意随机标识：${randomUUID()}。所有参数由你决定，请避免陈旧套路，每次尝试不同的人物、背景与主题。返回结构：{"title":"剧本名称","params":{"theme":"具体主题与主线，2至1000字","people":"人物姓名、身份、目标及关系","background":"时代、地点与世界背景","style":"逆袭/复仇/甜宠/家庭/悬疑/都市中的一个值","styleNote":"具体表达风格","episodes":3,"duration":2,"twist":"反转、爽点和悬念要求"}}。episodes须为1至80的整数，优先选择3至8集；duration须为1至10的整数。文本字段均不能为空，每个字段不超过1000字。`
      }
    ],
    { phase: 'planning', temperature: 0.9, maxTokens: 2500, signal: job.controller.signal }
  )
  let result
  try {
    result = configurationSchema.safeParse(
      JSON.parse(
        text
          .trim()
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
      )
    )
  } catch {
    /* 下方统一返回结构化结果错误，禁止应用部分参数。 */
  }
  ensure(result?.success, 502, 'CONFIGURATION_INVALID', '模型返回的故事设定不完整或格式有误，请重试；当前参数未改变')
  return result.data
}
