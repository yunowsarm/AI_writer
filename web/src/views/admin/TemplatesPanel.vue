<script setup>
/** 官方模板维护：完整参数与大纲编辑、上架下架都记录审计。 */
import { ref, onMounted } from 'vue'
import { api } from '../../api/client'
import { genres, defaultParams } from '../../shared/format'
import { reportError, success } from '../../shared/feedback'
const items = ref([]),
  draft = ref(null),
  busy = ref(false)

/**
 * 读取全部官方模板，包含已下架记录。
 */
async function load() {
  busy.value = true
  try {
    items.value = await api('/admin/templates')
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 创建独立编辑草稿；已有模板通过 JSON 克隆，避免表单修改直接污染列表数据。
 */
function edit(t) {
  draft.value = t ? JSON.parse(JSON.stringify(t)) : { title: '', genre: '逆袭', description: '', outline: '', params: defaultParams(), status: 'active' }
}

/**
 * 同步模板题材与生成风格，按是否已有 ID 选择新增或更新接口。
 */
async function save() {
  try {
    draft.value.params.style = draft.value.genre
    await api('/admin/templates' + (draft.value.id ? '/' + draft.value.id : ''), {
      method: draft.value.id ? 'PATCH' : 'POST',
      body: draft.value
    })
    draft.value = null
    success('官方模板已保存')
    await load()
  } catch (e) {
    reportError(e)
  }
}

/**
 * 保留模板内容，仅切换 active/offline 状态，成功后刷新列表。
 */
async function toggle(t) {
  try {
    await api('/admin/templates/' + t.id, {
      method: 'PATCH',
      body: { ...t, status: t.status === 'active' ? 'offline' : 'active' }
    })
    success('模板状态已更新')
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
      <h2>官方模板</h2>
      <el-button type="primary" @click="edit()">
        <el-icon class="leading-icon" aria-hidden="true"><Plus /></el-icon>
        新增模板
      </el-button>
    </div>
    <el-table :data="items" show-overflow-tooltip>
      <el-table-column prop="title" label="模板名称" min-width="180" />
      <el-table-column prop="genre" label="题材" width="100" />
      <el-table-column prop="uses" label="使用次数" width="100" />
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <el-tag :type="row.status === 'active' ? 'success' : 'info'">{{ row.status === 'active' ? '已上架' : '已下架' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" min-width="170">
        <template #default="{ row }">
          <el-button text @click="edit(row)">编辑</el-button>
          <el-button text :type="row.status === 'active' ? 'danger' : 'primary'" @click="toggle(row)">{{ row.status === 'active' ? '下架' : '上架' }}</el-button>
        </template>
      </el-table-column>
    </el-table>
  </section>
  <el-dialog :model-value="!!draft" @close="draft = null" title="官方模板编辑" width="700px">
    <el-form v-if="draft" label-position="top">
      <el-form-item label="模板名称"><el-input v-model="draft.title" maxlength="120" /></el-form-item>
      <div class="form-two">
        <el-form-item label="题材">
          <el-select v-model="draft.genre"><el-option v-for="g in genres" :key="g" :label="g" :value="g" /></el-select>
        </el-form-item>
        <el-form-item label="计划集数"><el-input-number v-model="draft.params.episodes" :min="1" :max="80" /></el-form-item>
      </div>
      <el-form-item label="模板简介"><el-input v-model="draft.description" type="textarea" :rows="2" maxlength="5000" /></el-form-item>
      <el-form-item label="故事主题"><el-input v-model="draft.params.theme" type="textarea" :rows="2" maxlength="1000" /></el-form-item>
      <el-form-item label="人物设定"><el-input v-model="draft.params.people" type="textarea" :rows="2" /></el-form-item>
      <el-form-item label="背景"><el-input v-model="draft.params.background" /></el-form-item>
      <el-form-item label="单集时长（分钟）"><el-input-number v-model="draft.params.duration" :min="1" :max="10" /></el-form-item>
      <el-form-item label="反转与爽点要求"><el-input v-model="draft.params.twist" type="textarea" /></el-form-item>
      <el-form-item label="分集框架与大纲"><el-input v-model="draft.outline" type="textarea" :rows="8" /></el-form-item>
      <el-button type="primary" @click="save">保存模板</el-button>
    </el-form>
  </el-dialog>
</template>
