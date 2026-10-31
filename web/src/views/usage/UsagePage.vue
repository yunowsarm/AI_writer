<script setup>
/** AI 用量视图：时间 / 模型筛选、真实 Token 趋势、请求明细及缺失数据提示。 */
import { cnyRange } from '../../shared/currency'
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../../api/client'
import { reportError } from '../../shared/feedback'
import { dateLabel } from '../../shared/format'
import UsageTrendChart from './UsageTrendChart.vue'

const days = ref(7),
  model = ref(''),
  page = ref(1),
  pageSize = ref(20),
  data = ref(null),
  busy = ref(false),
  error = ref(''),
  chartMetric = ref('requests')

const pricingUrl = 'https://api-docs.deepseek.com/quick_start/pricing/'

/**
 * 将数字转换为带中文千位分隔的展示文本。
 */
const number = (value) => Number(value || 0).toLocaleString('zh-CN')

/**
 * 真实缺失的 Token 显示“未返回”，与实际零消耗区分。
 */
const tokens = (value) => (value === null || value === undefined ? '未返回' : number(value))
const costRange = cnyRange
const statusText = { running: '调用中', completed: '成功', failed: '失败', cancelled: '已停止' }
const operationText = {
  randomize: '随机故事设定',
  'append-episode': 'AI 续写分集',
  generate: '剧本生成',
  continue: '续写',
  expand: '扩写',
  shorten: '精简',
  style: '风格改写',
  regenerate: '重创作',
  evaluate: '质量评估',
  optimize: '一键优化'
}
// 按 UTC 补齐筛选窗口内每天的图表位置；缺失 Token 的提示仍使用后端采集覆盖率。
const trend = computed(() =>
  Array.from({ length: days.value }, (_, i) => {
    const date = new Date()
    date.setUTCDate(date.getUTCDate() - days.value + 1 + i)
    const key = date.toISOString().slice(0, 10)
    const row = data.value?.daily.find((d) => d.day.slice(0, 10) === key)
    return {
      day: key,
      requests: Number(row?.requests || 0),
      tokens: Number(row?.tokens || 0),
      promptTokens: Number(row?.promptTokens || 0),
      completionTokens: Number(row?.completionTokens || 0),
      pricedRequests: Number(row?.pricedRequests || 0),
      offPeakCny: Number(row?.offPeakCny || 0),
      peakCny: Number(row?.peakCny || 0)
    }
  })
)
const chartUnit = computed(() => (chartMetric.value === 'requests' ? '次调用' : chartMetric.value === 'tokens' ? '已记录 Token' : '人民币费用（按官方谷价）'))
let sequence = 0

/**
 * 按日期、模型和页码查询 AI 用量，使用递增序号避免旧响应覆盖新筛选结果。
 * 数据、错误提示和加载状态均只接受最后一次请求的结果。
 */
async function load() {
  const stamp = ++sequence
  busy.value = true
  error.value = ''
  try {
    const result = await api('/me/usage?' + new URLSearchParams({ days: days.value, model: model.value, page: page.value, size: pageSize.value }))
    // 用户快速切换筛选条件时，较早发出的慢请求不得覆盖最后一次查询。
    if (stamp === sequence) data.value = result
  } catch (e) {
    if (stamp === sequence) {
      error.value = e.message
      reportError(e)
    }
  } finally {
    if (stamp === sequence) busy.value = false
  }
}

// 时间或模型筛选变化时重置页码，旧请求结果由 load 中的序号检查丢弃。
watch([days, model, pageSize], () => {
  page.value = 1
  load()
})
onMounted(load)
</script>
<template>
  <div class="usage-view" v-loading="busy">
    <div class="usage-heading">
      <div>
        <h2>我的 AI 用量</h2>
        <p>仅展示你自己的模型调用与 Token 消耗。</p>
      </div>
      <div class="usage-filters">
        <el-radio-group v-model="days">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
        <el-select v-model="model" placeholder="全部模型">
          <el-option label="全部模型" value="" />
          <el-option v-for="m in data?.availableModels || []" :key="m" :label="m" :value="m" />
        </el-select>
        <el-button @click="load">刷新</el-button>
      </div>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="data">
      <div class="usage-cards">
        <article class="panel">
          <span class="usage-label">模型调用次数</span>
          <strong>
            {{ number(data.summary.requests) }}
            <small>次</small>
          </strong>
          <p>来自 {{ number(data.summary.tasks) }} 项 AI 任务</p>
        </article>
        <article class="panel">
          <span class="usage-label">已记录 Token</span>
          <strong>{{ number(data.summary.totalTokens) }}</strong>
          <p>以模型实际返回值为准</p>
        </article>
        <article class="panel">
          <span class="usage-label">调用成功率</span>
          <strong>{{ data.summary.successRate === null ? '—' : data.summary.successRate + '%' }}</strong>
          <p>成功 {{ number(data.summary.completed) }} · 失败 {{ number(data.summary.failed) }}</p>
        </article>
        <article class="panel">
          <span class="usage-label">平均响应耗时</span>
          <strong>
            {{ data.summary.requests - data.summary.running ? (data.summary.averageMs / 1000).toFixed(1) : '—' }}
            <small>秒</small>
          </strong>
          <p>已停止 {{ number(data.summary.cancelled) }} · 调用中 {{ number(data.summary.running) }}</p>
        </article>
        <article class="panel">
          <span class="usage-label">官方费用估算</span>
          <strong>{{ data.summary.pricedRequests ? costRange(data.summary.offPeakCny, data.summary.peakCny) : '—' }}</strong>
          <p>{{ number(data.summary.pricedRequests) }} 次可计价 · 谷价至峰价（元）</p>
        </article>
      </div>
      <div class="panel token-breakdown">
        <div>
          <span>输入 Token</span>
          <b>{{ number(data.summary.promptTokens) }}</b>
        </div>
        <div>
          <span>输出 Token</span>
          <b>{{ number(data.summary.completionTokens) }}</b>
        </div>
        <div>
          <span>返回用量的调用</span>
          <b>{{ number(data.summary.knownUsage) }} / {{ number(data.summary.requests) }}</b>
        </div>
        <div>
          <span>未返回用量的调用</span>
          <b>{{ number(data.summary.missingUsage) }}</b>
        </div>
      </div>

      <div class="usage-chart-layout">
        <section class="panel usage-chart">
          <div class="panel-heading">
            <h2>每日用量趋势</h2>
            <el-radio-group v-model="chartMetric" size="small">
              <el-radio-button value="requests">调用次数</el-radio-button>
              <el-radio-button value="tokens">Token</el-radio-button>
              <el-radio-button value="cost">费用估算</el-radio-button>
            </el-radio-group>
          </div>
          <div class="trend-unit">{{ chartUnit }} · UTC 日期 · 悬浮查看明细</div>
          <UsageTrendChart :trend="trend" :metric="chartMetric" />
          <p class="usage-footnote">
            {{ data.summary.requests ? '按调用发起日期汇总，切换上方指标查看不同用量趋势。' : '当前范围还没有模型调用，开始 AI 创作后将自动记录。' }}
          </p>
        </section>
        <section class="panel model-distribution">
          <h2>模型使用分布</h2>
          <el-empty v-if="!data.models.length" description="暂无调用记录" :image-size="70" />
          <article v-for="m in data.models" :key="m.model + (m.provider_base_url || '')">
            <div>
              <b>{{ m.providerName ? m.providerName + ' / ' : '' }}{{ m.model }}</b>
              <span>{{ number(m.requests) }} 次</span>
            </div>
            <el-progress :percentage="Math.round((Number(m.requests) / Math.max(1, data.summary.requests)) * 100)" :show-text="false" :stroke-width="5" />
            <p>{{ number(m.tokens) }} Token · {{ m.knownUsage }} 次返回用量</p>
            <p v-if="m.pricedRequests">费用 {{ costRange(m.offPeakCny, m.peakCny) }}（{{ m.pricedRequests }} 次可计价）</p>
          </article>
        </section>
      </div>
      <section class="panel usage-detail">
        <div class="panel-heading">
          <h2>调用明细</h2>
        </div>
        <el-table :data="data.items" stripe show-overflow-tooltip table-layout="fixed" empty-text="当前范围暂无模型调用记录">
          <el-table-column prop="provider_name" label="供应商" min-width="120" />
          <el-table-column label="时间" width="130">
            <template #default="{ row }">{{ dateLabel(row.created_at) }}</template>
          </el-table-column>
          <el-table-column prop="nickname" label="创作者" min-width="100" />
          <el-table-column prop="model" label="模型" min-width="150" />
          <el-table-column label="用途" min-width="120">
            <template #default="{ row }">
              {{
                row.phase === 'outline'
                  ? '生成大纲'
                  : row.phase === 'episode'
                    ? '生成第 ' + row.episode_no + ' 集'
                    : row.phase === 'evaluation'
                      ? '评估第 ' + row.episode_no + ' 集'
                      : row.phase === 'consistency'
                        ? '全剧一致性检查'
                        : row.phase === 'verification'
                          ? '优化候选复核'
                          : operationText[row.operation] || row.operation
              }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'completed' ? 'success' : row.status === 'failed' ? 'danger' : 'info'">{{ statusText[row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="输入 Token" width="110">
            <template #default="{ row }">{{ tokens(row.prompt_tokens) }}</template>
          </el-table-column>
          <el-table-column label="输出 Token" width="110">
            <template #default="{ row }">{{ tokens(row.completion_tokens) }}</template>
          </el-table-column>
          <el-table-column label="总 Token" width="110">
            <template #default="{ row }">{{ tokens(row.total_tokens) }}</template>
          </el-table-column>
          <el-table-column label="费用估算（元）" min-width="145">
            <template #default="{ row }">{{ costRange(row.offPeakCny, row.peakCny) }}</template>
          </el-table-column>
          <el-table-column label="耗时" width="90">
            <template #default="{ row }">{{ row.status === 'running' ? '进行中' : (row.elapsed_ms / 1000).toFixed(1) + ' 秒' }}</template>
          </el-table-column>
          <el-table-column prop="error_code" label="错误标识" min-width="160" />
        </el-table>
        <el-pagination
          v-if="data.total > 0"
          v-model:current-page="page"
          v-model:page-size="pageSize"
          class="pagination"
          :total="data.total"
          :page-sizes="[10, 20, 50, 60]"
          layout="sizes, prev, pager, next, jumper, total"
          @current-change="load" />
      </section>
      <p class="usage-disclaimer">
        仅统计你在本系统的调用，不包含你的 Key 在其他应用的使用量；未返回 Token 的调用不作估算。费用按官方峰／谷价格区间显示，连接测试不计入生成调用，费用以 DeepSeek 平台账单为准。
      </p>
    </template>
  </div>
</template>
<style scoped>
.usage-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 25px;
}
.usage-heading h2 {
  font-size: 19px;
  font-weight: 500;
}
.usage-heading p {
  font-size: 14px;
  color: var(--theme-ink-a592b4, #a592b4);
  margin-top: 10px;
}
.usage-filters {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.usage-filters .el-select {
  width: 165px;
}
.usage-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 18px;
}
.usage-cards .panel {
  padding: 23px;
}
.usage-label {
  font-size: 14px;
  color: var(--theme-ink-a28cae, #a28cae);
}
.usage-cards strong {
  display: block;
  font-size: 30px;
  font-weight: 500;
  color: var(--theme-ink-6c547e, #6c547e);
  margin: 20px 0 15px;
}
.usage-cards small {
  font-size: 14px;
  margin-left: 8px;
  color: var(--theme-ink-b39ebf, #b39ebf);
  font-weight: 400;
}
.usage-cards .panel:last-child strong {
  font-size: 24px;
  overflow-wrap: anywhere;
}
.usage-cards p {
  font-size: 13px;
  color: var(--theme-ink-b29ac0, #b29ac0);
}
.token-breakdown {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 20px;
  margin: 20px 0;
}
.token-breakdown > div {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-right: 1px solid var(--line);
}
.token-breakdown > div:last-child {
  border: 0;
}
.token-breakdown span {
  font-size: 14px;
  color: var(--theme-ink-a692b5, #a692b5);
}
.token-breakdown b {
  font-size: 20px;
  font-weight: 500;
  color: var(--theme-ink-8a719e, #8a719e);
}
.usage-chart-layout {
  display: grid;
  grid-template-columns: minmax(0, 1.7fr) minmax(230px, 1fr);
  gap: 20px;
  margin-top: 23px;
}
.usage-chart-layout > section {
  margin: 0;
}
.pricing-link {
  color: var(--purple);
}
.trend-unit,
.usage-footnote {
  font-size: 13px;
  color: var(--theme-ink-b3a0bf, #b3a0bf);
}
.usage-footnote {
  line-height: 1.8;
}
.model-distribution > h2 {
  margin-bottom: 25px;
}
.model-distribution article + article {
  margin-top: 24px;
}
.model-distribution article > div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 14px;
  color: var(--theme-ink-9c82ae, #9c82ae);
  margin-bottom: 10px;
}
.model-distribution article b {
  font-weight: 500;
  overflow-wrap: anywhere;
}
.model-distribution article p {
  font-size: 13px;
  color: var(--theme-ink-b9a5c5, #b9a5c5);
  margin-top: 10px;
}
.usage-detail {
  margin-top: 23px;
}
.usage-detail {
  overflow-x: auto;
}
.usage-disclaimer {
  font-size: 13px;
  color: var(--theme-ink-aa98b9, #aa98b9);
  line-height: 1.9;
  margin-top: 20px;
}
@media (max-width: 1200px) {
  .usage-heading {
    align-items: flex-start;
    flex-direction: column;
  }
  .usage-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .usage-cards .panel {
    padding: 17px;
  }
  .usage-cards strong {
    font-size: 25px;
  }
}
@media (max-width: 800px) {
  .usage-cards {
    grid-template-columns: repeat(2, 1fr);
  }
  .token-breakdown {
    grid-template-columns: repeat(2, 1fr);
  }
  .usage-chart-layout {
    grid-template-columns: 1fr;
  }
  .usage-filters .el-radio-button :deep(.el-radio-button__inner) {
    font-size: 14px;
    padding: 9px;
  }
  .usage-filters .el-select {
    width: 145px;
  }
  .usage-chart .panel-heading {
    flex-wrap: wrap;
  }
}
</style>
