<script setup>
/** 个人剧本库：分页筛选、手动新建、软删除和进入编辑。 */
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import { genres, statusLabel, dateLabel, defaultParams } from '../../shared/format'
import { reportError, success, confirmAction } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import EmptyState from '../../components/EmptyState.vue'
const router = useRouter(),
  items = ref([]),
  total = ref(0),
  page = ref(1),
  query = ref(''),
  status = ref('all'),
  busy = ref(false),
  error = ref(''),
  dialog = ref(false),
  draft = ref({ title: '', genre: '逆袭', synopsis: '' }),
  saving = ref(false)

/**
 * 按页码、关键词及可见性或审核状态查询我的剧本。
 */
async function load() {
  busy.value = true
  try {
    const r = await api('/scripts?' + new URLSearchParams({ page: page.value, q: query.value, status: status.value }))
    items.value = r.items
    total.value = r.total
    error.value = ''
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

/**
 * 创建私有剧本后追加首个空白分集，再进入编辑页面。
 */
async function create() {
  saving.value = true
  try {
    const r = await api('/scripts', {
      method: 'POST',
      body: {
        ...draft.value,
        config: { ...defaultParams(), style: draft.value.genre, theme: draft.value.synopsis },
        tags: []
      }
    })
    await api('/scripts/' + r.id + '/episodes', { method: 'POST', body: { title: '第 1 集' } })
    router.push('/scripts/' + r.id)
  } catch (e) {
    reportError(e)
  } finally {
    saving.value = false
  }
}

/**
 * 确认后删除剧本并刷新列表；公开撤回和软删除由后端处理。
 */
async function remove(s) {
  if (!(await confirmAction('删除《' + s.title + '》后会同时撤回公开内容，确认继续？'))) return
  try {
    await api('/scripts/' + s.id, { method: 'DELETE' })
    success('剧本已删除')
    await load()
  } catch (e) {
    reportError(e)
  }
}

// 切换作品状态后重置页码，再读取对应列表。
watch(status, () => {
  page.value = 1
  load()
})
onMounted(load)
</script>
<template>
  <PageHeading title="你的故事，都在这里。" description="整理创作、回到灵感，让每一部作品慢慢成形。">
    <el-button @click="dialog = true">
      <el-icon class="leading-icon" aria-hidden="true"><Plus /></el-icon>
      空白剧本
    </el-button>
    <el-button type="primary" @click="router.push('/create')">
      <el-icon class="leading-icon" aria-hidden="true"><MagicStick /></el-icon>
      AI 创作
    </el-button>
  </PageHeading>
  <div class="list-tools">
    <div class="filter-tabs">
      <button
        v-for="t in [
          { v: 'all', l: '全部' },
          { v: 'private', l: '私有草稿' },
          { v: 'pending', l: '待审核' },
          { v: 'public', l: '已公开' },
          { v: 'rejected', l: '审核未通过' }
        ]"
        :key="t.v"
        :class="{ selected: status === t.v }"
        @click="status = t.v">
        {{ t.l }}
      </button>
    </div>
    <el-input
      class="search-field"
      v-model="query"
      clearable
      placeholder="搜索剧本"
      :prefix-icon="'Search'"
      @keyup.enter="
        () => {
          page = 1
          load()
        }
      "
      @clear="
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
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <div v-loading="busy">
    <EmptyState v-if="!items.length && !busy" description="开始创作，或试试其他关键词。"><el-button @click="dialog = true">创建一部剧本</el-button></EmptyState>
    <div v-else class="library-list">
      <div v-for="s in items" :key="s.id" class="library-row">
        <span class="file-icon">
          <el-icon><Document /></el-icon>
        </span>
        <div class="library-title" @click="router.push('/scripts/' + s.id)">
          <h3>{{ s.title }}</h3>
          <p>{{ s.genre }} · {{ s.episode_count }} 集 · {{ s.words }} 字</p>
        </div>
        <span class="status">{{ statusLabel(s) }}</span>
        <span class="muted">{{ dateLabel(s.updated_at) }}</span>
        <el-button @click="router.push('/scripts/' + s.id)">继续编辑</el-button>
        <el-button text type="danger" @click="remove(s)">删除</el-button>
      </div>
    </div>
  </div>
  <el-pagination v-if="total > 12" class="pagination" v-model:current-page="page" :page-size="12" :total="total" layout="prev,pager,next,total" @current-change="load" />
  <el-dialog v-model="dialog" title="新建空白剧本" width="500px">
    <el-form label-position="top" @submit.prevent="create">
      <el-form-item label="剧本名称"><el-input v-model="draft.title" maxlength="120" /></el-form-item>
      <el-form-item label="题材">
        <el-select v-model="draft.genre"><el-option v-for="g in genres" :key="g" :label="g" :value="g" /></el-select>
      </el-form-item>
      <el-form-item label="故事简介"><el-input type="textarea" v-model="draft.synopsis" :rows="3" maxlength="5000" /></el-form-item>
      <el-button type="primary" native-type="submit" :loading="saving">创建并开始编辑</el-button>
    </el-form>
  </el-dialog>
</template>
