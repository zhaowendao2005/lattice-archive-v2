/**
 * ============================================================================
 * 应用环境 Store（平台尺寸 / 主题 / 侧栏折叠 / 开发者模式）
 * ============================================================================
 * 为什么这些状态放全局而不走路由：
 *   它们是「跨页面持续生效的环境配置」，与当前看到哪个页面无关；
 *   即使刷新丢失也不影响业务正确性（属于纯体验层状态）。
 */
import { defineStore } from 'pinia';

/** 四套平台尺度：iOS 44pt / iPadOS 44pt / Windows 40epx / Windows 紧凑 32epx */
export type PlatformMode = 'ios' | 'ipados' | 'windows-standard' | 'windows-compact';
/** 主题：跟随系统 / 强制亮 / 强制暗 */
export type ThemeMode = 'system' | 'light' | 'dark';

/**
 * 应用全局环境域。
 *
 * 注意：主 Tab 与会话/设置子页的选择态已下沉为路由（见 src/router/index.ts），
 * 此处不再持有任何"当前位置"状态，只保留真正跨页面共享的环境配置。
 */
export const useAppStore = defineStore('app', {
  state: () => ({
    /** 当前运行或模拟的平台尺寸环境 */
    platform: 'windows-standard' as PlatformMode,
    /** 业务左侧栏是否折叠（纯 CSS 折叠，DOM 树保持 100% 恒定） */
    isSidebarCollapsed: false,
    /** 主题外观模式 */
    themeMode: 'system' as ThemeMode,
    /** 开发者模式开关 */
    developerMode: false,
  }),

  actions: {
    /** 切换平台尺度：同时把 data-platform 写到 body 上，供 CSS 令牌选择器生效 */
    setPlatform(mode: PlatformMode) {
      this.platform = mode;
      if (typeof document !== 'undefined') {
        document.body.setAttribute('data-platform', mode);
      }
    },

    /** 侧栏折叠开关（纯 CSS 折叠，DOM 不销毁，避免重渲染抖动） */
    toggleSidebar() {
      this.isSidebarCollapsed = !this.isSidebarCollapsed;
    },

    /** 显式设置折叠态（窗口变窄时由布局调用） */
    setSidebarCollapsed(collapsed: boolean) {
      this.isSidebarCollapsed = collapsed;
    },

    /** 开发者模式：开启后设置页才会出现调试类子页 */
    setDeveloperMode(enabled: boolean) {
      this.developerMode = enabled;
    },

    toggleDeveloperMode() {
      this.developerMode = !this.developerMode;
    },

    /**
     * 切换主题：
     * · system → 不写 class，交给 style.css 里的 prefers-color-scheme 自动跟随；
     * · light/dark → 在 <html> 上挂对应 class，覆盖系统偏好。
     */
    setThemeMode(mode: ThemeMode) {
      this.themeMode = mode;
      if (typeof document !== 'undefined') {
        const root = document.documentElement;
        root.classList.remove('dark', 'light');
        if (mode === 'dark') {
          root.classList.add('dark');
        } else if (mode === 'light') {
          root.classList.add('light');
        }
      }
    },
  },
});
