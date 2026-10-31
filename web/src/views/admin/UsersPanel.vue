<script setup>
/** 用户管理：真实禁用会使现有会话失效；管理员账号受保护。 */
import { ref, onMounted } from 'vue'
import { api } from '../../api/client'
import { reportError, success, confirmAction } from '../../shared/feedback'
import { dateLabel } from '../../shared/format'
const items = ref([]),
  page = ref(1),
  total = ref(0),
  query = ref(''),
  busy = ref(false)

/**
 * 按关键词及页码查询用户管理列表和总数。
 */
async function load() {
  busy.value = true
  try {
    const r = await api('/admin/users?' + new URLSearchParams({ page: page.value, q: query.value }))
    items.value = r.items
    total.value = r.total
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 确认后切换用户启用状态，成功后刷新列表；账号保护与会话撤销由后端执行。
 */
async function toggle(u) {
  if (!(await confirmAction((u.status === 'active' ? '禁用后该用户会立即退出，无法继续写操作。' : '恢复该用户的登录与创作权限。') + '确认继续？'))) return
  try {
    await api('/admin/users/' + u.id, {
      method: 'PATCH',
      body: { status: u.status === 'active' ? 'disabled' : 'active' }
    })
    success('用户状态已更新')
    load()
  } catch (e) {
    reportError(e)
  }
}
onMounted(load)
</script>
<template>
  <section class="panel" v-loading="busy">
    <div class="panel-heading">
      <h2>用户列表</h2>
      <el-input
        v-model="query"
        class="search-field"
        clearable
        placeholder="昵称或邮箱"
        @keyup.enter="
          () => {
            page = 1
            load()
          }
        ">
        <template #append>
          <el-button
            @click="
              () => {
                page = 1
                load()
              }
            ">
            搜索
          </el-button>
        </template>
      </el-input>
    </div>
    <el-table :data="items" show-overflow-tooltip>
      <el-table-column prop="nickname" label="用户" min-width="120" />
      <el-table-column prop="email" label="账号邮箱" min-width="200" />
      <el-table-column prop="scripts" label="剧本数" width="90" />
      <el-table-column label="角色" width="100">
        <template #default="{ row }">{{ row.role === 'admin' ? '管理员' : '创作者' }}</template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'danger'">{{ row.status === 'active' ? '正常' : '已禁用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="注册时间" min-width="130">
        <template #default="{ row }">{{ dateLabel(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.role !== 'admin'" text :type="row.status === 'active' ? 'danger' : 'primary'" @click="toggle(row)">{{ row.status === 'active' ? '禁用账号' : '恢复账号' }}</el-button>
          <span v-else class="fine muted">管理员保护</span>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination v-if="total > 12" class="pagination" v-model:current-page="page" :total="total" :page-size="12" layout="prev,pager,next,total" @current-change="load" />
  </section>
</template>
