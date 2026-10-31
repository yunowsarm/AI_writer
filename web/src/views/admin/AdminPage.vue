<script setup>
/** 后台入口：按职责加载管理面板，避免将后台业务堆入单一组件。 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHeading from '../../components/PageHeading.vue'
import MetricsPanel from './MetricsPanel.vue'
import UsersPanel from './UsersPanel.vue'
import TemplatesPanel from './TemplatesPanel.vue'
import ReviewsPanel from './ReviewsPanel.vue'
import ModerationPanel from './ModerationPanel.vue'
import { adminNavigation } from '../../shared/adminNavigation'
const route = useRoute(),
  router = useRouter()
// 以 URL 查询参数同步面板，刷新后保留入口；未知 tab 回退到数据看板。
const tab = computed({
    get: () => (tabs.some((t) => t.key === route.query.tab) ? route.query.tab : 'metrics'),
    set: (value) => router.replace({ query: { tab: value } })
  }),
  tabs = adminNavigation.map((item) => ({ ...item, component: { metrics: MetricsPanel, users: UsersPanel, templates: TemplatesPanel, reviews: ReviewsPanel, moderation: ModerationPanel }[item.key] }))
</script>
<template>
  <PageHeading :title="tabs.find((t) => t.key === tab).label" description="维护有序的创作空间，让好故事被安心看见。" eyebrow="STUDIO MANAGEMENT" />
  <div class="admin-workspace"><component :is="tabs.find((t) => t.key === tab).component" /></div>
</template>

<style>
/* 管理列表：较长内容省略并提供提示，操作列保持清晰，主题沿用 Element Plus 变量。 */
.admin-workspace .el-table {
  --el-table-header-bg-color: var(--el-fill-color-light);
  border: 1px solid var(--line);
  border-radius: 10px;
  margin-top: 18px;
}
.admin-workspace .el-table th.el-table__cell {
  padding: 14px 0;
  color: var(--el-text-color-primary);
  font-weight: 600;
}
.admin-workspace .el-table td.el-table__cell {
  padding: 14px 0;
}
.admin-workspace .el-table .cell {
  font-size: 15px;
  line-height: 1.6;
  padding-inline: 16px;
  word-break: break-word;
}
.admin-workspace .el-table .el-button + .el-button {
  margin-left: 4px;
}
.admin-workspace .el-table .el-button.is-text {
  padding: 7px 9px;
}
.admin-workspace .el-table .el-tag {
  font-size: 13px;
}
</style>
