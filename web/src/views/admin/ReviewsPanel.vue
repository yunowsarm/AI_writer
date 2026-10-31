<script setup>
/** 公开审核：查看冻结版本，再通过或填写原因驳回；重复审批由后端拒绝。 */
import { ref, onMounted, watch } from 'vue'
import { api } from '../../api/client'
import { reportError, success, askText, confirmAction } from '../../shared/feedback'
import { dateLabel } from '../../shared/format'
const items = ref([]),
  page = ref(1),
  total = ref(0),
  status = ref('pending'),
  busy = ref(false),
  preview = ref(null),
  episode = ref(0)

/**
 * 根据审核状态和页码读取申请列表，预览内容使用提交时冻结的快照。
 */
async function load() {
  busy.value = true
  try {
    const r = await api('/admin/reviews?' + new URLSearchParams({ page: page.value, status: status.value }))
    items.value = r.items
    total.value = r.total
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 通过前确认快照标题，驳回时收集原因，再提交审核决定。
 * 成功后关闭预览并刷新申请列表；最终审核状态及重复处理由后端控制。
 */
async function decide(r, approve) {
  let reason = ''
  if (approve) {
    if (!(await confirmAction('确认通过《' + r.snapshot.title + '》的此审核版本？'))) return
  } else {
    reason = await askText('驳回申请', '请填写可供作者修改参考的具体原因')
    if (!reason) return
  }
  try {
    await api('/admin/reviews/' + r.id + '/decision', { method: 'POST', body: { approve, reason } })
    preview.value = null
    success(approve ? '已通过并发布' : '已驳回申请')
    load()
  } catch (e) {
    reportError(e)
  }
}

// 审核状态变化时回到第一页，再按新状态查询。
watch(status, () => {
  page.value = 1
  load()
})
onMounted(load)
</script>
<template>
  <section class="panel" v-loading="busy">
    <div class="panel-heading">
      <h2>公开剧本审核</h2>
      <el-select v-model="status" class="short-select">
        <el-option label="待审核" value="pending" />
        <el-option label="已通过" value="approved" />
        <el-option label="已驳回" value="rejected" />
        <el-option label="已撤回" value="cancelled" />
        <el-option label="全部" value="all" />
      </el-select>
    </div>
    <el-table :data="items" show-overflow-tooltip>
      <el-table-column label="剧本" min-width="200">
        <template #default="{ row }">{{ row.snapshot.title }}</template>
      </el-table-column>
      <el-table-column prop="nickname" label="创作者" min-width="120" />
      <el-table-column label="提交时间" min-width="140">
        <template #default="{ row }">{{ dateLabel(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="{ pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'info' }[row.status]">
            {{ { pending: '待审核', approved: '已通过', rejected: '已驳回', cancelled: '已撤回' }[row.status] }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="270" fixed="right">
        <template #default="{ row }">
          <el-button
            text
            @click="
              () => {
                preview = row
                episode = 0
              }
            ">
            查看快照
          </el-button>
          <el-button v-if="row.status === 'pending'" text type="primary" @click="decide(row, true)">通过</el-button>
          <el-button v-if="row.status === 'pending'" text type="danger" @click="decide(row, false)">驳回</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination v-if="total > 12" class="pagination" :total="total" :page-size="12" v-model:current-page="page" layout="prev,pager,next,total" @current-change="load" />
  </section>
  <el-dialog :model-value="!!preview" @close="preview = null" :title="preview?.snapshot.title + ' · 待审快照'" width="850px">
    <template v-if="preview">
      <p class="preview-intro">{{ preview.snapshot.synopsis }}</p>
      <el-select v-model="episode"><el-option v-for="(e, i) in preview.snapshot.episodes" :key="e.id" :label="e.title" :value="i" /></el-select>
      <div class="preview-script">{{ preview.snapshot.episodes[episode]?.content_text }}</div>
      <el-alert v-if="preview.reason" :title="'审核意见：' + preview.reason" type="info" :closable="false" />
      <div v-if="preview.status === 'pending'" class="dialog-actions">
        <el-button type="primary" @click="decide(preview, true)">审核通过</el-button>
        <el-button type="danger" @click="decide(preview, false)">驳回并填写原因</el-button>
      </div>
    </template>
  </el-dialog>
</template>
