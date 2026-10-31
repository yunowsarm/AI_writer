<script setup>
/** 全局主题入口：显式选择明亮、暗色或随系统，并展示当前选中模式。 */
import { computed } from 'vue'
import { Sunny, Moon, Monitor, Check } from '@element-plus/icons-vue'
import { useTheme } from '../stores/theme'
const theme = useTheme()
const options = [
  { value: 'light', label: '明亮', icon: Sunny },
  { value: 'dark', label: '暗色', icon: Moon },
  { value: 'system', label: '随系统', icon: Monitor },
]
const current = computed(() => options.find((option) => option.value === theme.mode))
</script>
<template>
  <el-dropdown trigger="click" @command="theme.setMode">
    <button
      type="button"
      class="theme-trigger"
      aria-label="切换颜色主题"
      :title="'当前主题：' + current.label"
    >
      <el-icon aria-hidden="true"><component :is="current.icon" /></el-icon>
      <span class="theme-label">{{ current.label }}</span>
    </button>
    <template #dropdown>
      <el-dropdown-menu class="theme-menu">
        <el-dropdown-item
          v-for="option in options"
          :key="option.value"
          :command="option.value"
          :class="{ 'theme-selected': theme.mode === option.value }"
        >
          <el-icon aria-hidden="true"><component :is="option.icon" /></el-icon>
          <span>{{ option.label }}</span>
          <el-icon v-if="theme.mode === option.value" class="theme-check" aria-hidden="true"
            ><Check
          /></el-icon>
        </el-dropdown-item>
      </el-dropdown-menu>
    </template>
  </el-dropdown>
</template>
<style scoped>
.theme-trigger {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  color: var(--el-text-color-regular);
  background: var(--el-bg-color);
  font-size: 14px;
  transition:
    color 0.2s ease,
    background-color 0.2s ease,
    border-color 0.2s ease;
}
.theme-trigger:hover {
  color: var(--purple);
  background: var(--purple-light);
  border-color: var(--purple);
}
.theme-trigger .el-icon {
  font-size: 16px;
}
.theme-check {
  margin-left: auto;
  color: var(--purple);
}
.theme-menu .el-dropdown-menu__item {
  min-width: 130px;
  gap: 8px;
}
.theme-selected {
  color: var(--purple);
}
@media (max-width: 650px) {
  .theme-label {
    display: none;
  }
  .theme-trigger {
    padding: 7px;
  }
}
</style>
