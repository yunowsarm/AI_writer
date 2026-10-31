<script setup>
/** 根节点初始化主题；登录和密码重置页也提供主题入口。 */
import { onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { useTheme } from './stores/theme'
import ThemeSwitcher from './components/ThemeSwitcher.vue'
const route = useRoute(),
  theme = useTheme()
onBeforeUnmount(theme.dispose)
</script>
<template>
  <ThemeSwitcher
    v-if="route.path === '/login' || route.path === '/reset-password'"
    class="auth-theme-switch"
  />
  <router-view />
</template>
