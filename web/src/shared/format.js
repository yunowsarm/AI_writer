/** 纯展示工具：日期、题材封面与状态文案，避免页面重复硬编码。 */
export const genres = ['逆袭', '复仇', '甜宠', '家庭', '悬疑', '都市']

/** 题材使用统一 SVG 图标名称，供模板和社区卡片复用；未知题材回退到剧本文档。 */
export const genreIcon = (genre) =>
  ({
    逆袭: 'TrendCharts',
    复仇: 'Key',
    甜宠: 'Sugar',
    家庭: 'House',
    悬疑: 'Search',
    都市: 'OfficeBuilding'
  })[genre] || 'Document'

/**
 * 将题材映射为预设封面样式，未知题材回退到 sage。
 */
export const coverClass = (genre) => ({ 逆袭: 'sunrise', 甜宠: 'rose', 悬疑: 'night', 家庭: 'sage', 复仇: 'plum', 都市: 'sand' })[genre] || 'sage'

/**
 * 将服务端时间统一显示为北京时间的月日和时分。
 * 无时区的日期字符串按 UTC 解释；无值显示“刚刚”，无法解析时保留原值。
 */
export function dateLabel(value) {
  if (!value) return '刚刚'
  const date = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z')
  return Number.isNaN(+date)
    ? value
    : new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(date)
}

/**
 * 按待审核、驳回、已公开、私有的优先级生成作品状态文案。
 */
export const statusLabel = (s) => (s.review_status === 'pending' ? '待审核' : s.review_status === 'rejected' ? '审核未通过' : s.visibility === 'public' ? '已公开' : '私有草稿')

/**
 * 返回一份新的创作参数对象，避免不同页面或表单共享可变默认值。
 */
export const defaultParams = () => ({
  theme: '',
  people: '',
  background: '当代都市',
  style: '逆袭',
  styleNote: '',
  episodes: 3,
  duration: 2,
  twist: '每集结尾设置悬念，反转符合人物动机。'
})
