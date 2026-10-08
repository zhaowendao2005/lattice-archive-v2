import { defineStore } from 'pinia';

export type PlatformMode = 'ios' | 'ipados' | 'windows-standard' | 'windows-compact';
export type MainAppTab = 'chats' | 'archive' | 'settings';
export type SettingsSubTab = 'platform' | 'appearance' | 'developer' | 'general' | 'storage';
export type ThemeMode = 'system' | 'light' | 'dark';

export const useAppStore = defineStore('app', {
  state: () => ({
    /** 当前运行或模拟的平台尺寸环境 */
    platform: 'windows-standard' as PlatformMode,
    /** 当前主视图 Tab */
    activeTab: 'chats' as MainAppTab,
    /** 业务左侧栏是否折叠（纯 CSS 折叠，DOM 树保持 100% 恒定） */
    isSidebarCollapsed: false,
    /** 设置页当前激活的子页面 */
    activeSettingsTab: 'platform' as SettingsSubTab,
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

    setActiveTab(tab: MainAppTab) {
      this.activeTab = tab;
    },

    toggleSidebar() {
      this.isSidebarCollapsed = !this.isSidebarCollapsed;
    },

    setSidebarCollapsed(collapsed: boolean) {
      this.isSidebarCollapsed = collapsed;
    },

    setActiveSettingsTab(tab: SettingsSubTab) {
      this.activeSettingsTab = tab;
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
