/** 页面与访问控制：前端守卫改善体验，最终权限以服务端为准。 */
import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from './stores/auth'
import AppLayout from './layouts/AppLayout.vue'
export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior: () => ({ top: 0 }),
  routes: [
    { path: '/demo-scan', component: () => import('./views/auth/DemoScanPage.vue'), meta: { public: true, title: '演示扫码确认' } },
    {
      path: '/login',
      component: () => import('./views/auth/AuthPage.vue'),
      meta: { public: true, title: '登录 / 注册' }
    },
    {
      path: '/reset-password',
      component: () => import('./views/auth/ResetPassword.vue'),
      meta: { public: true, title: '重置密码' }
    },
    {
      path: '/',
      component: AppLayout,
      children: [
        {
          path: '',
          name: 'home',
          component: () => import('./views/home/HomePage.vue'),
          meta: { title: '创作工作台' }
        },
        {
          path: 'create',
          name: 'create',
          component: () => import('./views/create/CreatePage.vue'),
          meta: { title: 'AI 剧本创作' }
        },
        {
          path: 'scripts',
          name: 'scripts',
          component: () => import('./views/scripts/LibraryPage.vue'),
          meta: { title: '我的剧本' }
        },
        {
          path: 'scripts/:id',
          name: 'editor',
          component: () => import('./views/editor/EditorPage.vue'),
          meta: { title: '剧本编辑器' }
        },
        {
          path: 'templates',
          name: 'templates',
          component: () => import('./views/templates/TemplatesPage.vue'),
          meta: { title: '灵感模板库' }
        },
        {
          path: 'community',
          name: 'community',
          component: () => import('./views/community/CommunityPage.vue'),
          meta: { title: '剧本广场', public: true }
        },
        {
          path: 's/:id',
          name: 'public-script',
          component: () => import('./views/community/ScriptDetail.vue'),
          meta: { title: '公开剧本', public: true }
        },
        {
          path: 'favorites',
          name: 'favorites',
          component: () => import('./views/community/FavoritesPage.vue'),
          meta: { title: '我的收藏' }
        },
        {
          path: 'profile',
          name: 'profile',
          component: () => import('./views/profile/ProfilePage.vue'),
          meta: { title: '个人中心' }
        },
        {
          path: 'settings/api',
          name: 'api-settings',
          component: () => import('./views/settings/ApiSettingsPage.vue'),
          meta: { title: '个人 API 配置' }
        },
        {
          path: 'usage',
          name: 'usage',
          component: () => import('./views/usage/UsagePage.vue'),
          meta: { title: '我的 AI 用量' }
        },
        {
          path: 'admin',
          name: 'admin',
          component: () => import('./views/admin/AdminPage.vue'),
          meta: { title: '管理后台', admin: true }
        }
      ]
    },
    { path: '/:pathMatch(.*)*', redirect: '/' }
  ]
})

/**
 * 全局访问守卫：首次访问初始化会话，再检查公开页面和管理员入口。
 * 未登录跳转保留目标地址，便于登录后返回；路由检查不能替代服务端权限校验。
 */
router.beforeEach(async (to) => {
  const auth = useAuth()
  if (!auth.ready) {
    try {
      await auth.init()
    } catch (e) {
      if (!to.meta.public) return { path: '/login', query: { error: '服务连接失败，请确认后端和数据库已启动' } }
    }
  }
  if (!to.meta.public && !auth.user) return { path: '/login', query: { redirect: to.fullPath } }
  // 兼容旧后台书签，新入口对所有登录用户开放，页面只读取自己的配置和用量。
  if (to.path === '/admin' && to.query.tab === 'api') return '/settings/api'
  if (to.path === '/admin' && to.query.tab === 'usage') return '/usage'
  if (to.meta.admin && auth.user?.role !== 'admin') return '/'
  if (to.path === '/login' && auth.user) return '/'
  document.title = to.meta.title || 'AI 短剧创作系统'
})
