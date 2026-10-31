// vue-router 的工厂函数 + 路由记录类型；createWebHistory 表示用 HTML5 History 模式（无 # 号）
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
// 守卫里需要读取登录态，所以直接引入鉴权 Store（Pinia 已在 main.ts 中先于 router 安装）
import { useAuthStore } from '@/stores/auth/stores/authStore';
import { installWorkspaceTransition } from './workspaceTransition';

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
  // ── 鉴权域：/auth ────────────────────────────────────────────────────────
  // AuthLayout = 左右分栏外壳（左壁纸 / 右表单），子页只在右栏内切换
  {
    path: '/auth',
    component: () => import('@/views/auth/AuthLayout.vue'),
    children: [
      // 访问 /auth 时默认落到登录页
      { path: '', redirect: '/auth/login' },
      {
        path: 'login',
        name: 'auth-login',
        // 路由级懒加载：首屏只下载当前域代码，避免把聊天/归档等重模块打进初始包
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
  // ── 管理域：/admin ───────────────────────────────────────────────────────
  // meta.requiresAdmin 会被下方 beforeEach 读取；父路由打标记，子路由自动继承
  {
    path: '/admin',
    component: () => import('@/views/admin/AdminLayout.vue'),
    meta: { requiresAdmin: true },
    children: [
      { path: '', redirect: '/admin/users' },
      {
        path: 'users',
        name: 'admin-users',
        // 用户管理：VXE 表格 + 新增/删除弹窗（数据来自 /api/admin/users）
        component: () => import('@/views/admin/users/AdminUsersView.vue'),
      },
      {
        path: 'overview',
        name: 'admin-overview',
        component: () => import('@/views/admin/overview/AdminOverviewView.vue'),
      },
    ],
  },
  // ── 工作区：/workspace ──────────────────────────────────────────────────
  // AppLayout = 侧栏 + 内容区的常驻外壳；每个子页只是内容区里的一个插槽内容
  {
    path: '/workspace',
    component: () => import('@/views/layout/AppLayout.vue'),
    meta: { requiresAuth: true },
    children: [
      { path: '', redirect: '/workspace/chats' },
      {
        // 选中的会话属于「我在哪里」：可刷新还原、可深链，参数形如 user-123 / chat-456 / channel-789。
        path: 'chats/:chatKey?',
        name: 'chats',
        component: () => import('@/views/main/chats/ChatsView.vue'),
      },
      {
        path: 'archive',
        name: 'archive',
        component: () => import('@/views/main/archive/ArchivePlaceholderView.vue'),
      },
      {
        // 设置是「左子导航 + 右子页」的双栏结构：SettingsView 负责骨架，subviews/* 负责内容
        path: 'settings',
        component: () => import('@/views/main/settings/SettingsView.vue'),
        children: [
          { path: '', redirect: '/workspace/settings/platform' },
          { path: 'platform', name: 'settings-platform', component: () => import('@/views/main/settings/subviews/PlatformSettingsView.vue') },
          { path: 'appearance', name: 'settings-appearance', component: () => import('@/views/main/settings/subviews/AppearanceSettingsView.vue') },
          { path: 'general', name: 'settings-general', component: () => import('@/views/main/settings/subviews/GeneralSettingsView.vue') },
          { path: 'developer', name: 'settings-developer', component: () => import('@/views/main/settings/subviews/DeveloperSettingsView.vue') },
          { path: 'telegram', name: 'settings-telegram', component: () => import('@/views/main/settings/subviews/telegram-binding/TelegramBindingView.vue') },
          { path: 'storage', name: 'settings-storage', component: () => import('@/views/main/settings/subviews/StorageSettingsView.vue') },
        ],
      },
    ],
  },
  // 兜底路由：任何无法识别的地址统一回到工作区首页（不显示 404 页）
  { path: '/:pathMatch(.*)*', redirect: '/workspace/chats' },
];

const router = createRouter({
  // BASE_URL 由 Vite 注入：Web 为 '/'，Electron/Capacitor 打包后可能是子路径
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  // 路由切换后回到顶部，避免长列表页残留滚动位置
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * 访问守卫：
 * - 本地持有未过期会话时立即乐观放行（0ms 阻塞），同时在后台静默向远端校准会话；
 * - 若后台校准返回 401（会话已被服务端撤销或过期），自动清理本地状态并跳回对应登录页。
 */
router.beforeEach((to) => {
  // 拿到（或创建）鉴权 Store 单例。此处只在守卫里调用，不进 setup，避免组件时序问题
  const auth = useAuthStore();

  // 【乐观放行 + 后台校准】
  // 本地若已存有 Token，先不阻塞用户跳转（0ms），同时在后台向 /api/auth/me 校验；
  // 校验失败（401）时回调把用户踢回对应的登录页。
  // 这样冷启动不会出现「白屏等待网络」的体验。
  if (!auth.hasInitializedConnection && auth.sessionToken) {
    void auth.initializeSessionConnection((previousRole) => {
      // 校准失败的回调：只处理「用户当前正停留的页面」，不干扰已发生的其他跳转
      const current = router.currentRoute.value;
      if (current.meta.requiresAdmin) void router.replace({ name: 'admin-login' });
      else if (current.meta.requiresAuth) void router.replace({ name: previousRole === 'admin' ? 'admin-login' : 'auth-login' });
    });
  }

  // 同步守卫：管理员页要求 isAdmin（后端每次请求还会二次校验，前端只做体验层拦截）
  if (to.meta.requiresAdmin && !auth.isAdmin) return { name: 'admin-login' };
  // 工作区要求普通用户或管理员已登录
  if (to.meta.requiresAuth && !auth.isLoggedIn) return { name: 'auth-login' };
  // 已登录用户不应再看到登录/注册页：按角色分流到各自首页
  if (auth.isLoggedIn && (to.name === 'auth-login' || to.name === 'auth-register')) {
    return { name: auth.isAdmin ? 'admin-users' : 'chats' };
  }
  return true; // 其余情况放行
});

// 工作区分区切换的缓冲遮罩与空闲预取（注册在鉴权守卫之后：被守卫重定向的导航不会触发缓冲）
installWorkspaceTransition(router);

export default router;