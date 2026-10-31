<script setup>
/** 管理统计图：ECharts 柱状图，统一主题、悬浮详情和自适应尺寸。 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])
const props = defineProps({ rows: { type: Array, default: () => [] }, ranking: Boolean })
const root = ref(null)
let chart, resize, theme

/** 从 CSS 变量读取颜色，深浅主题切换时保留同一套统计口径。 */
function render() {
  if (!chart) return
  const style = getComputedStyle(document.documentElement)
  const color = (name, fallback) => style.getPropertyValue(name).trim() || fallback
  const ink = color('--el-text-color-regular', '#625b70')
  const axis = { axisLabel: { color: ink, fontSize: 14 }, axisLine: { show: false }, axisTick: { show: false } }
  const values = { ...axis, type: 'value', minInterval: 1, splitLine: { lineStyle: { color: color('--line', '#e7e4ee'), type: 'dashed' } } }
  const categories = { ...axis, type: 'category', data: props.rows.map((r) => (props.ranking ? r.genre : r.day.slice(5))), inverse: props.ranking }
  chart.setOption(
    {
      animation: !matchMedia('(prefers-reduced-motion: reduce)').matches,
      grid: { top: 42, left: props.ranking ? 85 : 44, right: 28, bottom: 35, containLabel: true },
      tooltip: {
        trigger: 'axis',
        confine: true,
        renderMode: 'richText',
        backgroundColor: color('--el-bg-color-overlay', '#fff'),
        textStyle: { color: ink, fontSize: 14 },
        axisPointer: { type: 'shadow' }
      },
      legend: { top: 0, bottom: null, show: !props.ranking, textStyle: { color: ink, fontSize: 14 } },
      xAxis: props.ranking ? values : categories,
      yAxis: props.ranking ? categories : values,
      series: [
        {
          name: props.ranking ? '剧本数' : '全部任务',
          type: 'bar',
          barMaxWidth: 28,
          itemStyle: { color: color('--purple', '#7960cd'), borderRadius: 4 },
          data: props.rows.map((r) => Number(r.count))
        },
        ...(!props.ranking ? [{ name: '成功完成', type: 'bar', barMaxWidth: 28, itemStyle: { color: '#58a58d', borderRadius: 4 }, data: props.rows.map((r) => Number(r.completed)) }] : [])
      ]
    },
    true
  )
}

onMounted(() => {
  chart = echarts.init(root.value)
  resize = new ResizeObserver(() => chart?.resize())
  resize.observe(root.value)
  theme = new MutationObserver(render)
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
  render()
})

watch(() => [props.rows, props.ranking], render, { deep: true })

onBeforeUnmount(() => {
  resize?.disconnect()
  theme?.disconnect()
  chart?.dispose()
})
</script>

<template><div ref="root" class="admin-chart" role="img" :aria-label="ranking ? '题材创作排行，悬浮查看数量' : '近七日全部任务及完成任务趋势，悬浮查看数量'" /></template>

<style scoped>
.admin-chart {
  width: 100%;
  height: 300px;
}
</style>
