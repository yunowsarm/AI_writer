/** 提示词模块：参数与系统指令分开；分集写作带上大纲和前情摘要。 */
import { rewriteBudget } from '../../../../shared/rewriteLength.js'
const system =
  '你是专业的中文短剧编剧。尊重人物动机、叙事逻辑和用户设定。输出适合短剧拍摄的中文剧本；场景用【场景】、角色表用【人物】、动作用【动作旁白】、台词用“角色名：台词”。不要解释你的思考过程。'

/**
 * 将创作参数转为分集大纲提示词，统一使用剧本格式系统指令。
 */
export function outlinePrompt(params) {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `根据以下 JSON 创作设定，生成标题、人物关系、完整故事大纲和每集梗概，共 ${params.episodes} 集。每集时长 ${params.duration} 分钟。${params.styleNote ? '重点遵循自定义剧本风格：' + params.styleNote + '。' : ''}只输出创作内容。\n${JSON.stringify(params)}`
    }
  ]
}

/**
 * 组装单集创作提示词，加入总纲和上一集结尾以维持叙事连续。
 * 对大纲和前文截取长度，避免携带无界上下文。
 */
export function episodePrompt(params, outline, index, previous) {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `创作第 ${index} / ${params.episodes} 集完整正文，每集约 ${params.duration} 分钟。遵循大纲，角色名字保持一致，有场景、人物、动作旁白、台词和集尾悬念。${params.styleNote ? '重点遵循自定义剧本风格：' + params.styleNote + '。' : ''}最后一集闭合主线。仅输出本集剧本，不重复整部大纲。\n设定：${JSON.stringify(params)}\n完整大纲：${outline.slice(0, 20000)}\n上一集结尾：${previous.slice(-6000)}`
    }
  ]
}

/**
 * 按操作类型生成片段处理提示词，区分续写新增内容与替换候选。
 * 上下文只作参考，选中文本与额外要求单独提供给模型。
 */
export function rewritePrompt({ operation, style, text, context, instruction, targetWords }) {
  const budget = rewriteBudget(text, operation, targetWords)
  const labels = {
    continue: '接着选中内容续写，输出新增部分',
    expand: '扩写选中内容，丰富细节，输出可直接替换的完整片段',
    shorten: '精简选中内容，保留关键信息，输出替换片段',
    style: '改写选中内容的风格为：' + style,
    regenerate: '重新创作该片段，保持角色和故事连续性'
  }
  return [
    {
      role: 'system',
      content:
        system +
        ` 本次只处理给定片段，原文 ${budget.source} 字，输出目标约 ${budget.target} 字，建议范围 ${budget.min}–${budget.max} 字。篇幅仅供参考，可根据表达完整性、剧情需要和作者的额外要求适当增减。避免无意义扩写、重复参考上下文或增加无关支线。只返回剧本正文。`
    },
    {
      role: 'user',
      content: `操作：${labels[operation]}\n额外要求：${instruction || ''}\n参考上下文：${context.slice(0, 16000)}\n待处理内容：${text}`
    }
  ]
}
