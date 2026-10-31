<script setup>
/** 创作工作区布局：保留原型 A 的导航与视觉，接入真实登录用户。 */
import { useRoute, useRouter } from 'vue-router'
import { onMounted, ref, computed } from 'vue'
import { adminNavigation } from '../shared/adminNavigation'
import { useAuth } from '../stores/auth'
import { api } from '../api/client'
import { reportError } from '../shared/feedback'
import StudioLogo from '../components/StudioLogo.vue'
import ThemeSwitcher from '../components/ThemeSwitcher.vue'
import TaskCenter from '../components/TaskCenter.vue'
const route = useRoute(),
  router = useRouter(),
  auth = useAuth()
const showNote = ref(true)
const isAdminPage = computed(() => route.name === 'admin')
const navs = [
  { name: 'home', label: '创作工作台', icon: 'Grid' },
  { name: 'create', label: 'AI 剧本创作', icon: 'MagicStick' },
  { name: 'scripts', label: '我的剧本', icon: 'Document' },
  { name: 'templates', label: '灵感模板库', icon: 'Collection' },
  { name: 'community', label: '剧本广场', icon: 'Compass' },
  { name: 'favorites', label: '我的收藏', icon: 'Star' },
  { name: 'usage', label: 'AI 用量', icon: 'DataLine' },
  { name: 'api-settings', label: 'API 配置', icon: 'Key' }
]
onMounted(() => api('/events/visit', { method: 'POST' }).catch(() => {}))

/** 关闭侧栏提示卡片；当前工作区内保持关闭，刷新页面可重新显示。 */
function closeNote() {
  showNote.value = false
}

/**
 * 退出当前账号，成功后跳转登录页；失败时保留当前页面并提示错误。
 */
async function logout() {
  try {
    await auth.logout()
    router.push('/login')
  } catch (e) {
    reportError(e)
  }
}
</script>
<template>
  <div class="app-shell">
    <aside class="sidebar">
      <!-- 外层容器保留品牌区间距，链接自身只包住 Logo，旁边留白不可点击。 -->
      <div class="brand-slot">
        <router-link to="/" class="brand" aria-label="回到创作工作台"><StudioLogo /></router-link>
      </div>
      <div class="workspace-label">
        {{ isAdminPage ? '系统管理' : auth.user ? '个人创作空间' : '发现故事' }}
      </div>
      <nav aria-label="工作区导航">
        <button
          v-for="n in isAdminPage ? adminNavigation : navs"
          :key="n.key || n.name"
          :aria-label="n.label"
          :title="n.label"
          :class="{ active: isAdminPage ? (route.query.tab || 'metrics') === n.key : route.name === n.name || (n.name === 'scripts' && route.name === 'editor') }"
          @click="router.push(isAdminPage ? { name: 'admin', query: { tab: n.key } } : { name: n.name })">
          <el-icon><component :is="n.icon" /></el-icon>
          {{ n.label }}
          <span v-if="n.name === 'create'" class="mini-ai">AI</span>
        </button>
      </nav>
      <div v-if="showNote && !isAdminPage" class="side-note">
        <button class="side-note-close" type="button" title="关闭创作提示" aria-label="关闭创作提示" @click="closeNote">
          <el-icon aria-hidden="true"><Close /></el-icon>
        </button>
        <div class="note-stars" aria-hidden="true">
          <el-icon><Opportunity /></el-icon>
        </div>
        <b>故事的下一幕，由你定义</b>
        <p>
          一个灵感，就能成为好故事。
          <br />
          让 AI 陪你把第一句写下来。
        </p>
        <button @click="router.push('/create')">
          开始一个新故事
          <el-icon aria-hidden="true"><TopRight /></el-icon>
        </button>
      </div>
      <div class="side-bottom">
        <button v-if="auth.user?.role === 'admin'" class="admin-nav-button" @click="router.push(isAdminPage ? '/' : '/admin')">
          <el-icon><component :is="isAdminPage ? 'Back' : 'Setting'" /></el-icon>
          <span>{{ isAdminPage ? '返回创作工作区' : '管理后台' }}</span>
        </button>
        <button class="account-button" @click="router.push(auth.user ? '/profile' : '/login')">
          <span class="avatar small">{{ auth.user?.nickname?.slice(0, 1) || '客' }}</span>
          <span class="account-copy">
            {{ auth.user?.nickname || '登录 / 注册' }}
            <small>{{ auth.user?.role === 'admin' ? '系统管理员' : '自由创作者' }}</small>
          </span>
          <el-icon><ArrowRight /></el-icon>
        </button>
      </div>
    </aside>
    <div class="main-shell">
      <header class="topbar">
        <div class="breadcrumb">
          工作空间
          <span>/</span>
          <b>{{ route.meta.title }}</b>
        </div>
        <div class="header-right">
          <ThemeSwitcher />
          <TaskCenter v-if="!route.path.startsWith('/admin')" />
          <span v-if="!route.path.startsWith('/admin')" class="prototype-badge">
            <i :class="{ online: auth.capabilities.aiConfigured }"></i>
            {{ auth.capabilities.aiConfigured ? 'AI 已配置' : 'AI 待配置' }}
          </span>
          <el-dropdown v-if="auth.user" @command="(v) => (v === 'logout' ? logout() : router.push('/profile'))">
            <button class="avatar">{{ auth.user.nickname.slice(0, 1) }}</button>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="profile">个人中心</el-dropdown-item>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          <el-button v-else @click="router.push('/login')">登录</el-button>
        </div>
      </header>
      <main><router-view /></main>
    </div>
  </div>
</template>

<style scoped>
/* 侧栏按可用高度排布：保留可读字号，优先压缩留白；极矮窗口仅菜单区滚动。 */
.sidebar {
  height: 100dvh;
  padding-block: 20px 12px;
  overflow: hidden;
  gap: 0;
}
.sidebar .workspace-label {
  margin: 20px 0 12px;
  line-height: 20px;
}
.sidebar nav {
  flex: 0 1 auto;
  min-height: 0;
  gap: 4px;
  overflow-y: auto;
  scrollbar-width: none;
}
.sidebar nav::-webkit-scrollbar {
  display: none;
}
.sidebar nav button {
  flex-shrink: 0;
  min-height: 44px;
  padding-block: 10px;
  line-height: 24px;
  white-space: nowrap;
}
.sidebar .side-note {
  margin: 18px 0 14px;
  padding: 14px 12px;
}
.sidebar .side-bottom {
  flex-shrink: 0;
  margin-top: auto;
  padding-top: 10px;
}
.sidebar .side-bottom > button {
  min-height: 44px;
  padding: 8px 12px;
}
.sidebar .account-copy {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 中等高度将宣传卡片收成单行入口，把空间留给完整导航与账号区。 */
@media (max-height: 900px) {
  .sidebar .side-note {
    padding: 10px 30px 10px 12px;
    margin-block: 12px;
  }
  .sidebar .side-note .note-stars,
  .sidebar .side-note > b,
  .sidebar .side-note > p {
    display: none;
  }
  .sidebar .side-note > button:not(.side-note-close) {
    margin: 0;
    min-height: 28px;
    line-height: 22px;
    gap: 6px;
  }
  .sidebar .side-note-close {
    top: 11px;
    right: 4px;
  }
}
@media (max-height: 760px) {
  .sidebar {
    padding-block: 14px 10px;
  }
  .sidebar .workspace-label {
    margin-block: 14px 8px;
  }
  .sidebar nav {
    gap: 3px;
  }
  .sidebar nav button {
    min-height: 42px;
    padding-block: 9px;
  }
  .sidebar .side-note {
    display: none;
  }
}
/* 窄屏沿用图标导航，避免原有大间距把账号入口挤出屏幕。 */
@media (max-width: 650px) {
  .sidebar nav {
    margin-top: 18px;
    gap: 5px;
  }
  .sidebar nav button {
    padding-inline: 10px;
  }
  .sidebar .side-bottom > button {
    padding-inline: 5px;
  }
}
</style>
