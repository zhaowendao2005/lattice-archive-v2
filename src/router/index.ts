import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { useAuthStore } from '@/stores/auth/stores/authStore';

/**
 * 路由表。
 *
 * 判定准则（详见 .rules/frontend-architecture.md 第五节）：
 * 1. 有独立 URL 语义、需可深链 / 可刷新还原 / 可前进后退的层级 → 进路由；
 * 2. 覆盖层、临时交互态（弹窗、右键菜单、侧栏折叠、列表选中） → 进 Pinia。
 *
 * 三个顶层域彼此平级，互不嵌套：
 *   /auth      鉴权域（用户登录、用户注册）
 *   /workspace 工作区（会话、归档、设置及其子页）
 *   /admin     管理域（管理员登录、控制台）
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/auth',
    component: () => import('@/views/auth/AuthLayout.vue'),
    children: [
      { path: '', redirect: '/auth/login' },
      {
        path: 'login',
        name: 'auth-login',
        component: () => import('@/views/auth/login/LoginView.vue'),
      },
      {
        path: 'register',
        name: 'auth-register',
        component: () => import('@/views/auth/register/RegisterView.vue'),
      },
    ],
  },
  {
    // 管理员登录独立于管理域外壳之外，避免"守卫打回登录页"形成自环
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('@/views/admin/login/AdminLoginView.vue'),
  },
  {
    path: '/admin',
    component: () => import('@/views/admin/AdminLayout.vue'),
    meta: { requiresAdmin: true },
    children: [
      { path: '', redirect: '/admin/users' },
      {
        path: 'users',
        name: 'admin-users',
        component: () => import('@/views/admin/users/AdminUsersView.vue'),
      },
      {
        path: 'overview',
        name: 'admin-overview',
        component: () => import('@/views/admin/overview/AdminOverviewView.vue'),
      },
    ],
  },
  {
    path: '/workspace',
    component: () => import('@/views/layout/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/workspace/chats' },
      {
        path: 'chats',
        name: 'chats',
        component: () => import('@/views/main/chats/ChatsView.vue'),
      },
      {
        path: 'archive',
        name: 'archive',
        component: () => import('@/views/main/archive/ArchivePlaceholderView.vue'),
      },
      {
        path: 'settings',
        component: () => import('@/views/main/settings/SettingsView.vue'),
        children: [
          { path: '', redirect: '/workspace/settings/platform' },
          { path: 'platform', name: 'settings-platform', component: () => import('@/views/main/settings/subviews/PlatformSettingsView.vue') },
          { path: 'appearance', name: 'settings-appearance', component: () => import('@/views/main/settings/subviews/AppearanceSettingsView.vue') },
          { path: 'general', name: 'settings-general', component: () => import('@/views/main/settings/subviews/GeneralSettingsView.vue') },
          { path: 'developer', name: 'settings-developer', component: () => import('@/views/main/settings/subviews/DeveloperSettingsView.vue') },
          { path: 'storage', name: 'settings-storage', component: () => import('@/views/main/settings/subviews/StorageSettingsView.vue') },
        ],
      },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/workspace/chats' },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/** 访问守卫：会话身份来自 authStore，未登录不得进入工作区，非管理员不得进入控制台。 */
router.beforeEach(async (to) => {
  const auth = useAuthStore();
  await auth.initializeSessionConnection();
  if (to.meta.requiresAdmin && !auth.isAdmin) return { name: 'admin-login' };
  if (to.meta.requiresAuth && !auth.isLoggedIn) return { name: 'auth-login' };
  if (auth.isLoggedIn && (to.name === 'auth-login' || to.name === 'auth-register')) {
    return { name: auth.isAdmin ? 'admin-users' : 'chats' };
  }
  return true;
});

export default router;