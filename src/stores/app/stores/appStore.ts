import { defineStore } from 'pinia';

export type PlatformMode = 'ios' | 'ipados' | 'windows-standard' | 'windows-compact';
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
    setPlatform(mode: PlatformMode) {
      this.platform = mode;
      if (typeof document !== 'undefined') {
        document.body.setAttribute('data-platform', mode);
      }
    },

    toggleSidebar() {
      this.isSidebarCollapsed = !this.isSidebarCollapsed;
    },

    setSidebarCollapsed(collapsed: boolean) {
      this.isSidebarCollapsed = collapsed;
    },

    setDeveloperMode(enabled: boolean) {
      this.developerMode = enabled;
    },

    toggleDeveloperMode() {
      this.developerMode = !this.developerMode;
    },

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
