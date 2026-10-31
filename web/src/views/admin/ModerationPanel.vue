<script setup>
/** 社区治理：下架已公开作品、处理举报、查看管理员操作日志。 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import { reportError, success, askText } from '../../shared/feedback'
import { dateLabel } from '../../shared/format'
const router = useRouter(),
  content = ref([]),
  reports = ref([]),
  audit = ref([]),
  busy = ref(false),
  page = ref(1),
  total = ref(0)
const errors = ref({})
const actionLabels = {
  'content.takedown': '下架作品',
  'report.resolve': '处理举报',
  'review.approve': '审核通过',
  'review.reject': '驳回作品',
  'user.active': '启用账号',
  'user.disabled': '禁用账号',
  'template.create': '新增模板',
  'template.update': '修改模板'
}

/**
 * 并行读取公开内容分页、待处理举报和审计日志，再更新三个治理区域。
 */
async function load() {
  busy.value = true
  try {
    errors.value = {}
    // 三个区域独立更新，单个接口失败时仍可处理其他管理工作。
    const results = await Promise.allSettled([api('/admin/content?page=' + page.value), api('/admin/reports'), api('/admin/audit')])
    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        errors.value[['content', 'reports', 'audit'][i]] = result.reason.message
        return
      }
      if (i === 0) {
        content.value = result.value.items
        total.value = result.value.total
      } else if (i === 1) reports.value = result.value
      else audit.value = result.value
    })
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 收集下架原因并提交治理接口；成功后刷新公开内容、举报及日志。
 */
async function takedown(id) {
  const reason = await askText('下架公开内容', '请输入下架原因，公开链接将立即失效')
  if (!reason) return
  try {
    await api('/admin/content/' + id + '/takedown', { method: 'POST', body: { reason } })
    success('已下架并记录原因')
    load()
  } catch (e) {
    reportError(e)
  }
}

/**
 * 仅将指定举报标记为已处理，随后刷新治理列表；不直接下架作品。
 */
async function resolve(r) {
  try {
    await api('/admin/reports/' + r.id, { method: 'PATCH' })
    success('已标记处理完成')
    load()
  } catch (e) {
    reportError(e)
  }
}
onMounted(load)
</script>
<template>
  <div v-loading="busy" class="moderation-panels">
    <section class="panel">
      <div class="panel-heading">
        <h2>公开作品</h2>
        <el-button @click="load">刷新</el-button>
      </div>
      <el-alert v-if="errors.content" :title="errors.content" type="error" :closable="false" show-icon />
      <el-table :data="content" empty-text="暂无公开作品" show-overflow-tooltip>
        <el-table-column prop="title" label="作品名称" min-width="180" />
        <el-table-column prop="nickname" label="创作者" min-width="140" />
        <el-table-column prop="genre" label="题材" min-width="110" />
        <el-table-column label="操作" width="230" fixed="right">
          <template #default="{ row }">
            <el-button text @click="router.push('/s/' + row.id)">查看公开页</el-button>
            <el-button text type="danger" @click="takedown(row.id)">下架</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-pagination v-if="total > 12" class="pagination" :total="total" :page-size="12" v-model:current-page="page" layout="prev,pager,next,total" @current-change="load" />
    </section>
    <section class="panel">
      <h2>待处理举报</h2>
      <el-alert v-if="errors.reports" :title="errors.reports" type="error" :closable="false" show-icon />
      <el-table :data="reports" empty-text="暂无待处理举报" show-overflow-tooltip>
        <el-table-column prop="nickname" label="举报人" width="130" />
        <el-table-column prop="script_id" label="作品 ID" width="100" />
        <el-table-column prop="reason" label="问题描述" min-width="250" />
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button text @click="router.push('/s/' + row.script_id)">查看</el-button>
            <el-button text type="danger" @click="takedown(row.script_id)">下架作品</el-button>
            <el-button text @click="resolve(row)">标记处理完成</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
    <section class="panel">
      <h2>最近操作日志</h2>
      <el-alert v-if="errors.audit" :title="errors.audit" type="error" :closable="false" show-icon />
      <el-table :data="audit" empty-text="暂无管理操作记录" show-overflow-tooltip>
        <el-table-column prop="nickname" label="管理员" width="150" />
        <el-table-column label="操作" min-width="150">
          <template #default="{ row }">
            <el-tag type="info">{{ actionLabels[row.action] || row.action }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="target_id" label="对象 ID" width="100" />
        <el-table-column label="原因 / 明细" min-width="220">
          <template #default="{ row }">{{ row.detail || '—' }}</template>
        </el-table-column>
        <el-table-column label="时间" width="190">
          <template #default="{ row }">{{ dateLabel(row.created_at) }}</template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>
