<script setup>
/**
 * AI 用量趋势图：按需引入 Apache ECharts，集中处理图表绘制、悬浮明细与尺寸变化。
 * 父页面只提供已聚合的每日数据和当前指标，避免业务统计逻辑散落在图表实现中。
 */
import { cny, cnyRange } from '../../shared/currency'
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { LineChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([LineChart, GridComponent, TooltipComponent, CanvasRenderer])

const props = defineProps({
  trend: { type: Array, default: () => [] },
  metric: { type: String, default: 'requests' }
})

const chartElement = ref(null)
let chart
let resizeObserver
let themeObserver

/** 将数值格式化为统一的中文分组数字。 */
const number = (value) => Number(value || 0).toLocaleString('zh-CN')

/** 费用维持官方人民币单位，小额价格保留必要小数。 */
const costRange = (item) => (item.pricedRequests ? cnyRange(item.offPeakCny, item.peakCny) : '暂不估算')

const metricValue = (item) => (props.metric === 'cost' ? Number(item.offPeakCny || 0) : Number(item[props.metric] || 0))

const metricName = () => (props.metric === 'requests' ? '调用次数' : props.metric === 'tokens' ? '已记录 Token' : '费用估算')

/**
 * 读取主题变量后一次性更新图表选项；主题切换和数据更新都复用该入口。
 */
function render() {
  if (!chart) return

  const style = getComputedStyle(document.documentElement)
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback
  const isCost = props.metric === 'cost'

  chart.setOption(
    {
      animation: !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationDuration: 180,
      grid: { top: 26, right: 20, bottom: 32, left: 56 },
      tooltip: {
        trigger: 'axis',
        confine: true,
        backgroundColor: color('--el-bg-color-overlay', '#ffffff'),
        borderColor: color('--line', '#e5dfeb'),
        borderWidth: 1,
        textStyle: { color: color('--theme-ink-63556f', '#63556f'), fontSize: 13 },
        extraCssText: 'box-shadow: 0 8px 20px rgba(77,58,93,.14); border-radius: 8px; padding: 10px 12px;',
        formatter: (items) => {
          const item = props.trend[items[0]?.dataIndex]
          if (!item) return ''

          return [
            '<b>' + item.day + '</b>',
            '调用 ' + number(item.requests) + ' 次',
            '输入 ' + number(item.promptTokens) + ' · 输出 ' + number(item.completionTokens) + ' Token',
            '官方费用 ' + costRange(item) + '（元）'
          ].join('<br/>')
        }
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: props.trend.map((item) => item.day),
        axisLine: { lineStyle: { color: color('--line', '#e5dfeb') } },
        axisTick: { show: false },
        axisLabel: {
          color: color('--theme-ink-aa98ba', '#aa98ba'),
          fontSize: 13,
          formatter: (value) => value.slice(5)
        }
      },
      yAxis: {
        type: 'value',
        minInterval: isCost ? 0 : 1,
        splitLine: {
          lineStyle: { color: color('--theme-line-ede8f3', '#ede8f3'), type: 'dashed' }
        },
        axisLabel: {
          color: color('--theme-ink-aa98ba', '#aa98ba'),
          fontSize: 13,
          formatter: (value) => (isCost ? cny(value) : number(value))
        }
      },
      series: [
        {
          name: metricName(),
          type: 'line',
          smooth: true,
          showSymbol: false,
          symbolSize: 6,
          emphasis: { scale: false, focus: 'series' },
          lineStyle: { color: color('--theme-accent-9274c9', '#9274c9'), width: 2.5 },
          itemStyle: { color: color('--theme-accent-9274c9', '#9274c9') },
          areaStyle: { color: color('--theme-surface-f1eafa', '#f1eafa'), opacity: 0.85 },
          data: props.trend.map(metricValue)
        }
      ]
    },
    true
  )
}

onMounted(async () => {
  await nextTick()
  chart = echarts.init(chartElement.value)
  resizeObserver = new ResizeObserver(() => chart?.resize())
  resizeObserver.observe(chartElement.value)
  themeObserver = new MutationObserver(render)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  render()
})

watch(() => [props.trend, props.metric], render, { deep: true })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  chart?.dispose()
})
</script>

<template>
  <div ref="chartElement" class="usage-trend-chart" role="img" :aria-label="'每日' + metricName() + '趋势，悬浮可查看详情'" />
</template>

<style scoped>
.usage-trend-chart {
  width: 100%;
  height: 255px;
  margin-top: 8px;
}
</style>
