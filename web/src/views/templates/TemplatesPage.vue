<script setup>
/** 模板库：预览完整设定、套用、收藏以及个人模板维护。 */
import { ref, onMounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { api } from '../../api/client'
import { genres } from '../../shared/format'
import { reportError, success, confirmAction } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import StoryCard from '../../components/StoryCard.vue'
import EmptyState from '../../components/EmptyState.vue'
import { useAuth } from '../../stores/auth'
const auth = useAuth()
import { useReactions } from '../../shared/useReactions'
const router = useRouter(),
  reactions = useReactions(),
  route = useRoute(),
  items = ref([]),
  total = ref(0),
  page = ref(1),
  genre = ref(''),
  kind = ref('all'),
  query = ref(''),
  preview = ref(null),
  busy = ref(false),
  editing = ref(false)

/**
 * 按题材、模板类型、关键词及页码读取当前可访问的模板。
 */
async function load() {
  busy.value = true
  try {
    const r = await api('/templates?' + new URLSearchParams({ page: page.value, genre: genre.value, kind: kind.value, q: query.value }))
    items.value = r.items
    total.value = r.total
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 读取模板详情并打开预览，初始进入只读模式。
 */
async function open(t) {
  try {
    preview.value = await api('/templates/' + t.id)
    editing.value = false
  } catch (e) {
    reportError(e)
  }
}

/**
 * 切换模板收藏，成功后同步当前卡片图标，访问权限由服务端再次确认。
 */
async function favorite(t) {
  await reactions.toggleFavorite(t, 'template')
}

/**
 * 提交个人模板的预览编辑内容，保存成功后退出编辑并刷新列表。
 */
async function save() {
  try {
    await api('/templates/' + preview.value.id, { method: 'PATCH', body: preview.value })
    success('个人模板已保存')
    editing.value = false
    load()
  } catch (e) {
    reportError(e)
  }
}

/**
 * 确认后移除个人模板，关闭预览并刷新列表。
 */
async function remove(t) {
  if (!(await confirmAction('移除个人模板《' + t.title + '》？'))) return
  try {
    await api('/templates/' + t.id, { method: 'DELETE' })
    preview.value = null
    success('已移除模板')
    load()
  } catch (e) {
    reportError(e)
  }
}

/** 作者确认后公开或撤回完整个人模板。 */
async function setVisibility() {
  const visibility = preview.value.visibility === 'public' ? 'private' : 'public'
  if (!(await confirmAction(visibility === 'public' ? '公开后其他用户可查看完整模板、收藏和套用，确认公开？' : '确认撤回公开？'))) return
  try {
    await api('/templates/' + preview.value.id + '/visibility', { method: 'PATCH', body: { visibility } })
    preview.value.visibility = visibility
    success('模板可见范围已更新')
    load()
  } catch (e) {
    reportError(e)
  }
}
// 切换题材或官方/个人类型后重置页码并重新查询。
watch([genre, kind], () => {
  page.value = 1
  load()
})

// 先读取列表，再按路由 preview 参数打开指定模板预览。
onMounted(async () => {
  await load()
  if (route.query.preview) await open({ id: route.query.preview })
})
</script>
<template>
  <PageHeading title="好故事，不必从空白开始。" description="个人模板默认私有，可在详情公开或撤回；公开模板可供大家收藏和套用。" />
  <div class="template-kind">
    <el-radio-group v-model="kind">
      <el-radio-button value="all">全部模板</el-radio-button>
      <el-radio-button value="official">官方模板</el-radio-button>
      <el-radio-button value="public">公开模板</el-radio-button>
      <el-radio-button value="personal">我的模板</el-radio-button>
    </el-radio-group>
    <el-input
      v-model="query"
      placeholder="搜索模板"
      clearable
      class="search-field"
      @keyup.enter="
        () => {
          page = 1
          load()
        }
      "
      @clear="load">
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
  <div class="filter-tabs standalone">
    <button v-for="g in ['', ...genres]" :key="g" :class="{ selected: genre === g }" @click="genre = g">
      {{ g || '全部' }}
    </button>
  </div>
  <div v-loading="busy">
    <EmptyState v-if="!busy && !items.length" description="没有匹配的模板。可在编辑器中把自己的剧本保存成模板。" />
    <div class="template-grid full-grid">
      <StoryCard
        v-for="t in items"
        :key="t.id"
        :item="t"
        :favorite-pending="reactions.pending.has('favorite:' + t.id)"
        @open="open"
        @favorite="favorite"
        @apply="router.push('/create?template=' + t.id)" />
    </div>
  </div>
  <el-pagination v-if="total > 12" class="pagination" :total="total" :page-size="12" v-model:current-page="page" layout="prev,pager,next,total" @current-change="load" />
  <el-dialog :model-value="!!preview" @close="preview = null" :title="editing ? '编辑个人模板' : preview?.title" width="700px">
    <template v-if="preview">
      <el-form v-if="editing" label-position="top">
        <el-form-item label="名称"><el-input v-model="preview.title" /></el-form-item>
        <el-form-item label="简介"><el-input v-model="preview.description" type="textarea" /></el-form-item>
        <el-form-item label="大纲"><el-input v-model="preview.outline" type="textarea" :rows="8" /></el-form-item>
      </el-form>
      <template v-else>
        <div class="preview-tags">
          <el-tag>{{ preview.genre }}</el-tag>
          <span>{{ preview.kind === 'official' ? '官方模板' : '个人模板' }} · {{ preview.params.episodes }} 集</span>
        </div>
        <p class="preview-intro">{{ preview.description }}</p>
        <dl class="template-params">
          <dt>故事主题</dt>
          <dd>{{ preview.params.theme }}</dd>
          <dt>人物设定</dt>
          <dd>{{ preview.params.people || '套用后自定义' }}</dd>
          <dt>故事背景</dt>
          <dd>{{ preview.params.background || '套用后自定义' }}</dd>
          <dt>反转要求</dt>
          <dd>{{ preview.params.twist }}</dd>
        </dl>
        <div class="preview-script">
          {{ preview.outline || '套用后根据你的主题生成完整分集大纲。' }}
        </div>
      </template>
      <div class="dialog-actions">
        <el-button v-if="preview.kind === 'personal' && preview.owner_id === auth.user?.id && !editing" @click="setVisibility">
          {{ preview.visibility === 'public' ? '撤回公开' : '公开模板' }}
        </el-button>
        <el-button v-if="editing" type="primary" @click="save">保存修改</el-button>
        <el-button v-else type="primary" @click="router.push('/create?template=' + preview.id)">
          套用模板
          <el-icon class="inline-icon" aria-hidden="true"><Right /></el-icon>
        </el-button>
        <el-button v-if="preview.kind === 'personal' && preview.owner_id === auth.user?.id && !editing" @click="editing = true">编辑模板</el-button>
        <el-button v-if="preview.kind === 'personal' && preview.owner_id === auth.user?.id" text type="danger" @click="remove(preview)">移除模板</el-button>
      </div>
    </template>
  </el-dialog>
</template>
