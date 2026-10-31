<script setup>
/** 公开广场：题材、标签检索与真实热度；未登录可浏览公开作品。 */
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useReactions } from '../../shared/useReactions'
import { api } from '../../api/client'
import { genres } from '../../shared/format'
import PageHeading from '../../components/PageHeading.vue'
import StoryCard from '../../components/StoryCard.vue'
import EmptyState from '../../components/EmptyState.vue'
const router = useRouter(),
  reactions = useReactions(),
  items = ref([]),
  genre = ref(''),
  query = ref(''),
  sort = ref('recent'),
  page = ref(1),
  total = ref(0),
  busy = ref(false),
  error = ref('')

/**
 * 按关键词、题材、排序及页码查询公开剧本，保留加载失败提示。
 */
async function load() {
  busy.value = true
  try {
    const r = await api('/public/scripts?' + new URLSearchParams({ genre: genre.value, q: query.value, sort: sort.value, page: page.value }))
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
 * 切换公开剧本的收藏状态；共享互动模块负责登录检查与请求防重复。
 */
async function favorite(s) {
  await reactions.toggleFavorite(s)
}

// 切换题材或排序时回到第一页，避免沿用上一筛选的页码。
watch([genre, sort], () => {
  page.value = 1
  load()
})
onMounted(load)
</script>
<template>
  <PageHeading title="在别人的故事里，遇见灵感。" description="发现、交流、共鸣，让创作不再是一个人的事。" eyebrow="STORIES WORTH DISCOVERING" />
  <div class="list-tools">
    <div class="filter-tabs">
      <button v-for="g in ['', ...genres]" :key="g" :class="{ selected: genre === g }" @click="genre = g">
        {{ g || '全部' }}
      </button>
    </div>
    <div class="search-tools">
      <el-input
        v-model="query"
        clearable
        placeholder="搜索标题、题材或标签"
        :prefix-icon="'Search'"
        @keyup.enter="
          () => {
            page = 1
            load()
          }
        "
        @clear="load" />
      <el-button
        @click="
          () => {
            page = 1
            load()
          }
        ">
        搜索
      </el-button>
      <el-select v-model="sort">
        <el-option label="最近更新" value="recent" />
        <el-option label="热度优先" value="hot" />
      </el-select>
    </div>
  </div>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
  <div v-loading="busy">
    <EmptyState v-if="!items.length && !busy" title="好故事，正在酝酿" description="广场只展示审核通过的公开剧本。写下第一部作品，与大家分享。">
      <el-button @click="router.push('/create')">开始创作</el-button>
    </EmptyState>
    <div v-else class="template-grid full-grid">
      <StoryCard
        v-for="s in items"
        :key="s.id"
        :item="s"
        type="script"
        :favorite-pending="reactions.pending.has('favorite:' + s.id)"
        :like-pending="reactions.pending.has('like:' + s.id)"
        @open="router.push('/s/' + s.id)"
        @favorite="favorite"
        @like="reactions.toggleLike" />
    </div>
  </div>
  <el-pagination v-if="total > 12" class="pagination" :total="total" :page-size="12" v-model:current-page="page" layout="prev,pager,next,total" @current-change="load" />
</template>
