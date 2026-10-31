<script setup>
/** 收藏夹：同时收集剧本与模板，失效目标仍可取消收藏。 */
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api/client'
import { reportError, success } from '../../shared/feedback'
import PageHeading from '../../components/PageHeading.vue'
import EmptyState from '../../components/EmptyState.vue'
const router = useRouter(),
  items = ref([]),
  total = ref(0),
  page = ref(1),
  busy = ref(false)

/**
 * 读取当前用户收藏分页，包含仍可取消的失效收藏占位记录。
 */
async function load() {
  busy.value = true
  try {
    const r = await api('/favorites?page=' + page.value)
    items.value = r.items
    total.value = r.total
  } catch (e) {
    reportError(e)
  } finally {
    busy.value = false
  }
}

/**
 * 按目标类型与 ID 取消收藏，成功后刷新当前页。
 */
async function remove(t) {
  try {
    await api(`/favorites/${t.type}/${t.id}`, { method: 'DELETE' })
    success('已取消收藏')
    await load()
  } catch (e) {
    reportError(e)
  }
}
onMounted(load)
</script>
<template>
  <PageHeading title="收藏每一次心动。" description="喜欢的剧本与模板，随时回来看看。" />
  <div v-loading="busy">
    <EmptyState v-if="!items.length && !busy" description="去广场读一个新故事，或收藏一份心仪的模板。"><el-button @click="router.push('/community')">发现剧本</el-button></EmptyState>
    <div v-else class="library-list">
      <div class="library-row" v-for="t in items" :key="t.type + '-' + t.id">
        <span class="file-icon">
          <el-icon><StarFilled /></el-icon>
        </span>
        <div class="library-title">
          <h3>{{ t.title }}</h3>
          <p>{{ t.type === 'script' ? '公开剧本' : '创作模板' }} · {{ t.genre || '暂不可用' }}</p>
        </div>
        <el-button v-if="!t.unavailable" @click="router.push(t.type === 'script' ? '/s/' + t.id : '/templates?preview=' + t.id)">查看{{ t.type === 'script' ? '剧本' : '模板' }}</el-button>
        <el-button text @click="remove(t)">取消收藏</el-button>
      </div>
    </div>
  </div>
  <el-pagination v-if="total > 12" class="pagination" :total="total" :page-size="12" v-model:current-page="page" layout="prev,pager,next,total" @current-change="load" />
</template>
