/**
 * ============================================================================
 * 应用启动入口（浏览器 / Electron / iOS Capacitor 三端共用）
 * ============================================================================
 * 职责仅三件事：
 *   1. 挂载前先做「WebKit 原生手感治理」的事件级防御；
 *   2. 创建 Vue 应用实例；
 *   3. 依次装入 Pinia（全局状态）与 Vue Router（页面路由），再挂载到 #app。
 *
 * 注意：这里不做任何业务初始化（会话恢复、权限校验）——
 * 那些都在 Pinia Store（authStore）与路由守卫里完成，避免启动顺序耦合。
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import './style.css'; // 全局样式与设计令牌（.rules/design-system-and-tokens.md 的唯一事实来源）
import App from './App.vue';
import router from './router';

// 拦截 WebKit 双击放大与多指缩放手势，保证 Native 客户端软件级交互触感
// 说明：CSS 的 touch-action / user-select 只能挡住「大部分」默认行为，
// iOS Safari/WKWebView 仍会对 300ms 内的连续 touchend 以及 gesture* 手势做缩放，
// 因此必须在 JS 入口显式 preventDefault（passive:false 才能生效）。
if (typeof window !== 'undefined') {
  let lastTouchEnd = 0; // 上一次 touchend 的时间戳，用于判定「极速双击」
  document.addEventListener(
    'touchend',
    (event) => {
      const now = Date.now();
      // 两次触摸结束间隔 ≤300ms 视为双击 → 阻止默认的缩放行为
      if (now - lastTouchEnd <= 300) {
        event.preventDefault();
      }
      lastTouchEnd = now;
    },
    { passive: false }
  );

  // iOS WebKit 私有的多指手势事件，直接全部掐掉，杜绝「双指捏合缩放网页」
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
  document.addEventListener('gestureend', (e) => e.preventDefault());
}

const app = createApp(App);

// Pinia 必须先于 Router 安装：路由守卫（beforeEach）内部会直接 useAuthStore()
app.use(createPinia());
app.use(router);
app.mount('#app');
