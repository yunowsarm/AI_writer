<script setup>
/** 质量报告图表：复用 ECharts 绘制维度雷达和逐集节奏，支持暗色及尺寸变化。 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import * as echarts from 'echarts/core'
import { RadarChart, LineChart } from 'echarts/charts'
import { RadarComponent, GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([RadarChart, LineChart, RadarComponent, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])
const props = defineProps({ result: Object })
const radarElement = ref(),
  rhythmElement = ref()
let radar, rhythm, resizeObserver, themeObserver

/** 从页面主题取色，分项未完成时保留缺口，不把缺失值当作零分。 */
function render() {
  if (!radar || !props.result) return
  const style = getComputedStyle(document.documentElement)
  const text = style.getPropertyValue('--el-text-color-regular').trim() || '#7d688d'
  const line = style.getPropertyValue('--el-border-color').trim() || '#e9e3ef'
  const purple = style.getPropertyValue('--el-color-primary').trim() || '#8060c7'
  const animation = !matchMedia('(prefers-reduced-motion: reduce)').matches
  radar.setOption(
    {
      animation,
      tooltip: { trigger: 'item' },
      radar: {
        radius: '60%',
        indicator: props.result.dimensions.map((d) => ({ name: d.label, max: 100 })),
        axisName: { color: text },
        splitLine: { lineStyle: { color: line } },
        splitArea: { show: false }
      },
      series: [
        {
          type: 'radar',
          data: [{ name: '质量维度', value: props.result.dimensions.map((d) => d.score), areaStyle: { color: purple, opacity: 0.15 }, lineStyle: { color: purple }, itemStyle: { color: purple } }]
        }
      ]
    },
    true
  )
  rhythm.setOption(
    {
      animation,
      color: [purple, '#ce9c61', '#6faaa1'],
      tooltip: { trigger: 'axis' },
      legend: { bottom: 0, textStyle: { color: text } },
      grid: { top: 15, bottom: 55, left: 35, right: 15 },
      xAxis: { type: 'category', data: props.result.episodes.map((e) => '第' + e.episodeNo + '集'), axisLabel: { color: text }, axisLine: { lineStyle: { color: line } } },
      yAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: text }, splitLine: { lineStyle: { color: line } } },
      series: [
        { key: 'conflict', name: '冲突' },
        { key: 'reversal', name: '反转' },
        { key: 'suspense', name: '悬念' }
      ].map((metric) => ({ name: metric.name, type: 'line', smooth: true, connectNulls: false, data: props.result.episodes.map((e) => e[metric.key]) }))
    },
    true
  )
}

onMounted(() => {
  radar = echarts.init(radarElement.value)
  rhythm = echarts.init(rhythmElement.value)
  resizeObserver = new ResizeObserver(() => {
    radar.resize()
    rhythm.resize()
  })
  resizeObserver.observe(radarElement.value)
  resizeObserver.observe(rhythmElement.value)
  themeObserver = new MutationObserver(render)
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  render()
})

watch(() => props.result, render, { deep: true })

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  themeObserver?.disconnect()
  radar?.dispose()
  rhythm?.dispose()
})
</script>

<template>
  <div class="quality-charts">
    <div>
      <h4>多维质量画像</h4>
      <div ref="radarElement" class="chart" role="img" aria-label="剧本质量雷达图" />
    </div>
    <div>
      <h4>各集节奏分布</h4>
      <div ref="rhythmElement" class="chart" role="img" aria-label="各集冲突反转悬念趋势" />
    </div>
  </div>
</template>

<style scoped>
.quality-charts {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 16px;
  margin-top: 24px;
}
.chart {
  height: 260px;
  width: 100%;
}
h4 {
  font-weight: 500;
  font-size: 16px;
}
@media (max-width: 700px) {
  .quality-charts {
    grid-template-columns: 1fr;
  }
}
</style>
