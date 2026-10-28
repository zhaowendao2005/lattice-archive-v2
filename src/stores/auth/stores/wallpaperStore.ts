import { defineStore } from 'pinia';
import { LOGIN_WALLPAPERS, WALLPAPER_INTERVAL, type LoginWallpaper } from '@/assets/login';

/**
 * 登录页壁纸轮替域。
 *
 * 轮替是"当前视觉主题"而非一次性交互，且必须在 登录 ↔ 注册 路由切换之间
 * 延续同一张壁纸（否则每次跳转都会闪回第一张），故入 Pinia。
 *
 * 注意：这里**不持有进度百分比**——进度环由纯 CSS 动画驱动（见 AuthWallpaperPanel），
 * 避免 60fps 的 JS 状态更新。
 */
export const useWallpaperStore = defineStore('login-wallpaper', {
  state: () => ({
    index: 0,
    /** true = 自动轮替；false = 暂停（悬停或手动操作后） */
    autoPlay: true,
    /** 定时器句柄，由 store 自身持有，避免组件卸载后泄漏 */
    timer: 0 as unknown as ReturnType<typeof setInterval>,
  }),

  getters: {
    current: (state): LoginWallpaper => LOGIN_WALLPAPERS[state.index] ?? LOGIN_WALLPAPERS[0],
    all: (): LoginWallpaper[] => LOGIN_WALLPAPERS,
    count: (): number => LOGIN_WALLPAPERS.length,
  },

  actions: {
    start() {
      if (this.timer) return;
      this.timer = setInterval(() => {
        if (this.autoPlay) this.next();
      }, WALLPAPER_INTERVAL);
    },

    stop() {
      if (!this.timer) return;
      clearInterval(this.timer);
      this.timer = 0 as unknown as ReturnType<typeof setInterval>;
    },

    setAutoPlay(enabled: boolean) {
      this.autoPlay = enabled;
    },

    toggleAutoPlay() {
      this.autoPlay = !this.autoPlay;
    },

    next() {
      this.index = (this.index + 1) % LOGIN_WALLPAPERS.length;
    },

    prev() {
      this.index = (this.index - 1 + LOGIN_WALLPAPERS.length) % LOGIN_WALLPAPERS.length;
    },

    goTo(index: number) {
      if (index < 0 || index >= LOGIN_WALLPAPERS.length) return;
      this.index = index;
    },
  },
});