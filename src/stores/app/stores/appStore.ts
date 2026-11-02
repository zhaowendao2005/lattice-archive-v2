/**
 * ============================================================================
 * 应用环境 Store（平台尺寸 / 主题 / 侧栏折叠 / 开发者模式）
 * ============================================================================
 * 为什么这些状态放全局而不走路由：
 *   它们是「跨页面持续生效的环境配置」，与当前看到哪个页面无关；
 *   即使刷新丢失也不影响业务正确性（属于纯体验层状态）。
 */
import { defineStore } from 'pinia';
import { mtprotoHub } from '@/stores/telegram/data-sources/mtprotoBridge';
import { notifyCloudActivity } from '@/stores/telegram/data-sources/tgRemoteDataSource';
import { useDebugLoggerStore } from './debugLoggerStore';

/** 四套平台尺度：iOS 44pt / iPadOS 44pt / Windows 40epx / Windows 紧凑 32epx */
export type PlatformMode = 'ios' | 'ipados' | 'windows-standard' | 'windows-compact';
/** 主题：跟随系统 / 强制亮 / 强制暗 */
export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_DEV_MODE_KEY = 'lattice.app.developer-mode.v1';

function readSavedDeveloperMode(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_DEV_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

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
    /** 开发者模式开关（已持久化并在启动时自动向本地 Worker 下发实际控制） */
    developerMode: typeof window !== 'undefined' ? readSavedDeveloperMode() : false,
    /**
     * 工作区分区（会话 / 归档 / 设置）切换进行中：覆盖「拉取路由分包 + 首次挂载重组件」整段耗时，
     * 由 src/router/workspaceTransition.ts 驱动，AppLayout 据此渲染缓冲遮罩与进度条。
     */
    isSectionSwitching: false,
  }),

  actions: {
    /** 分区切换开始 / 结束（仅由路由钩子调用） */
    setSectionSwitching(switching: boolean) {
      this.isSectionSwitching = switching;
    },

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

    /** 开发者模式：开启后实际控制底层网关追踪与日志采集并持久化 */
    setDeveloperMode(enabled: boolean) {
      this.developerMode = enabled;
      try {
        window.localStorage.setItem(STORAGE_DEV_MODE_KEY, String(enabled));
      } catch {
        // ignore
      }
      this.applyDeveloperMode(enabled);
    },

    toggleDeveloperMode() {
      this.setDeveloperMode(!this.developerMode);
    },

    applyDeveloperMode(enabled: boolean) {
      // 1. 实际控制本地 Worker：下发 setDebug 指令，启用/禁用底层 MTProto 网关追踪
      try {
        mtprotoHub.bridge().setDebug(enabled);
      } catch {
        // ignore
      }
      // 2. 实际控制日志采集 Store：关闭时停止深层详细事件收集
      try {
        const debugLogger = useDebugLoggerStore();
        if (enabled) {
          debugLogger.initialize();
        }
      } catch {
        // ignore
      }
      // 3. 调度顺风车同步将开发偏好持久化至云端
      try {
        notifyCloudActivity();
      } catch {
        // ignore
      }
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
