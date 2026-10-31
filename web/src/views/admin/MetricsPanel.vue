<script setup>
/** 真实统计：明确 PV、注册用户与任务成功数口径，不使用演示图表。 */
import { ref, onMounted, computed } from 'vue'
import { api } from '../../api/client'
import { reportError } from '../../shared/feedback'
import AdminChart from './AdminChart.vue'
const data = ref(null),
  busy = ref(false)
// 补齐近七个 UTC 自然日，无生成记录的日期显示为零，保持趋势图时间连续。
const days = computed(() =>
  Array.from({ length: 7 }, (_, i) => {
    const day = new Date()
    day.setUTCDate(day.getUTCDate() - 6 + i)
    const key = day.toISOString().slice(0, 10),
      found = data.value?.trend.find((t) => t.day.slice(0, 10) === key)
    return { day: key, count: found?.count || 0, completed: Number(found?.completed || 0) }
  })
)

/**
 * 读取 GET /admin/metrics，更新全站汇总、生成趋势和题材分布。
 */
async function load() {
  busy.value = true
  try {
    data.value = await api('/admin/metrics')
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}
onMounted(load)
</script>
<template>
  <div v-loading="busy">
    <div class="section-heading">
      <h2>系统运行概览</h2>
      <el-button @click="load">刷新数据</el-button>
    </div>
    <template v-if="data">
      <div class="admin-stats">
        <div
          class="panel"
          v-for="s in [
            { label: '累计页面访问 PV', value: data.visits, note: '工作区进入事件' },
            { label: '注册用户', value: data.users, note: '账号总量' },
            { label: 'AI 任务总数', value: data.generations, note: '成功 ' + data.completed + ' 次 · 含生成、评估与优化' },
            { label: '待审核作品', value: data.pending, note: '等待管理员处理' }
          ]"
          :key="s.label">
          <p>{{ s.label }}</p>
          <b>{{ s.value }}</b>
          <span>{{ s.note }}</span>
        </div>
      </div>
      <div class="chart-layout">
        <section class="panel">
          <div class="panel-heading">
            <h2>近七日 AI 任务数</h2>
            <span>UTC 日期 · 含成功、失败与停止</span>
          </div>
          <AdminChart :rows="days" />
          <p class="chart-note">实际成功生成 {{ data.completed }} 次；没有数据时显示 0。</p>
        </section>
        <section class="panel">
          <h2>题材创作排行</h2>
          <el-empty v-if="!data.genres.length" description="还没有剧本数据" :image-size="70" />
          <AdminChart v-else :rows="data.genres" ranking />
        </section>
      </div>
    </template>
  </div>
</template>
