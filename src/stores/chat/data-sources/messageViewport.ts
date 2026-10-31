/**
 * [DATA SOURCE] 消息流滚动容器句柄
 *
 * 视图层禁止持有 ref，滚动容器的 DOM 句柄与锚点计算统一收敛在此单例：
 * 视图只通过函数式 :ref 挂载元素，Store 在数据变化前后调用这里完成「保持可见位置」。
 */
export interface ScrollSnapshot { scrollTop: number; scrollHeight: number }
export type MediaVisibilityHandler = (target: string, visible: boolean) => void;

const NEAR_TOP_PX = 240;
const NEAR_BOTTOM_PX = 96;
/** 媒体预取边距：在进入视口前约一屏开始加载，离开该范围后取消尚未开始的下载。 */
const MEDIA_PREFETCH_MARGIN = '600px 0px';
/** 头像预取边距：覆盖左侧会话列表、会话头、消息流群成员与查看器页眉。 */
const AVATAR_PREFETCH_MARGIN = '160px 0px';

let element: HTMLElement | null = null;
let composerInput: HTMLInputElement | HTMLTextAreaElement | null = null;
let mediaObserver: IntersectionObserver | null = null;
let mediaHandler: MediaVisibilityHandler | null = null;
/** 已登记的媒体元素 → 目标标识（`${peerKey}:${messageId}`）。 */
const mediaTargets = new Map<Element, string>();
/** 播放可见性：GIF / 圆形视频只在真正位于视口（≥ 50%）内时播放，与 600px 预取范围分开判断。 */
let playbackObserver: IntersectionObserver | null = null;
let playbackHandler: MediaVisibilityHandler | null = null;
const playbackTargets = new Map<Element, string>();
/** 头像可见性观察器（以浏览器视口为根，支持多处同时展示同一 peer 头像）。 */
let avatarObserver: IntersectionObserver | null = null;
let avatarHandler: MediaVisibilityHandler | null = null;
const avatarTargets = new Map<Element, string>();
const visibleAvatarElements = new Map<string, Set<Element>>();

function ensureAvatarObserver(): IntersectionObserver | null {
  if (avatarObserver || typeof IntersectionObserver === 'undefined') return avatarObserver;
  avatarObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = avatarTargets.get(entry.target);
      if (!target) continue;
      updateAvatarElementVisibility(entry.target, target, entry.isIntersecting);
    }
  }, { root: null, rootMargin: AVATAR_PREFETCH_MARGIN });
  return avatarObserver;
}

function updateAvatarElementVisibility(node: Element, target: string, visible: boolean) {
  let set = visibleAvatarElements.get(target);
  if (visible) {
    const wasEmpty = !set || set.size === 0;
    if (!set) { set = new Set(); visibleAvatarElements.set(target, set); }
    set.add(node);
    if (wasEmpty) avatarHandler?.(target, true);
  } else if (set?.delete(node) && set.size === 0) {
    visibleAvatarElements.delete(target);
    avatarHandler?.(target, false);
  }
}

function rebuildPlaybackObserver() {
  playbackObserver?.disconnect();
  playbackObserver = null;
  if (!element || typeof IntersectionObserver === 'undefined') return;
  playbackObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = playbackTargets.get(entry.target);
      if (target) playbackHandler?.(target, entry.isIntersecting && entry.intersectionRatio >= 0.5);
    }
  }, { root: element, threshold: [0, 0.5] });
  playbackTargets.forEach((_, node) => playbackObserver?.observe(node));
}

function rebuildMediaObserver() {
  mediaObserver?.disconnect();
  mediaObserver = null;
  if (!element || typeof IntersectionObserver === 'undefined') return;
  mediaObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const target = mediaTargets.get(entry.target);
      if (target) mediaHandler?.(target, entry.isIntersecting);
    }
  }, { root: element, rootMargin: MEDIA_PREFETCH_MARGIN });
  mediaTargets.forEach((_, node) => mediaObserver?.observe(node));
}

export const messageViewport = {
  attach(target: Element | null) {
    const next = target instanceof HTMLElement ? target : null;
    if (next === element) return;
    element = next;
    // 观察根必须是滚动容器本身，预取边距才作用于消息流而非整个窗口。
    rebuildMediaObserver();
    rebuildPlaybackObserver();
  },

  onPlaybackVisibility(handler: MediaVisibilityHandler) { playbackHandler = handler; },

  observePlayback(node: Element, target: string) {
    const previous = playbackTargets.get(node);
    if (previous === target) return;
    playbackTargets.set(node, target);
    if (previous) {
      playbackObserver?.unobserve(node);
      playbackHandler?.(previous, false);
    }
    playbackObserver?.observe(node);
  },

  unobservePlayback(node: Element) {
    const target = playbackTargets.get(node);
    if (!target) return;
    playbackTargets.delete(node);
    playbackObserver?.unobserve(node);
    playbackHandler?.(target, false);
  },

  /** 媒体可见性回调由 Store 注册；视图通过指令登记元素，不持有任何 DOM 句柄。 */
  onMediaVisibility(handler: MediaVisibilityHandler) { mediaHandler = handler; },

  observeMedia(node: Element, target: string) {
    const previous = mediaTargets.get(node);
    if (previous === target) return;
    mediaTargets.set(node, target);
    if (previous) {
      // 元素被复用到另一张图片：旧目标视为离开，新目标重新观察以获得一次初始回调。
      mediaObserver?.unobserve(node);
      mediaHandler?.(previous, false);
    }
    mediaObserver?.observe(node);
  },

  unobserveMedia(node: Element) {
    const target = mediaTargets.get(node);
    if (!target) return;
    mediaTargets.delete(node);
    mediaObserver?.unobserve(node);
    mediaHandler?.(target, false);
  },

  onAvatarVisibility(handler: MediaVisibilityHandler) { avatarHandler = handler; },

  observeAvatar(node: Element, target: string | undefined) {
    const previous = avatarTargets.get(node);
    if (previous === target) return;
    if (previous) {
      avatarTargets.delete(node);
      avatarObserver?.unobserve(node);
      updateAvatarElementVisibility(node, previous, false);
    }
    if (!target) return;
    avatarTargets.set(node, target);
    ensureAvatarObserver()?.observe(node);
  },

  unobserveAvatar(node: Element) {
    const target = avatarTargets.get(node);
    if (!target) return;
    avatarTargets.delete(node);
    avatarObserver?.unobserve(node);
    updateAvatarElementVisibility(node, target, false);
  },

  isAttached() { return element !== null; },

  isNearTop() { return element ? element.scrollTop <= NEAR_TOP_PX : false; },

  /** 未挂载时视为在底部：首次渲染应直接贴底。 */
  isNearBottom() {
    if (!element) return true;
    return element.scrollHeight - element.scrollTop - element.clientHeight <= NEAR_BOTTOM_PX;
  },

  capture(): ScrollSnapshot | null {
    return element ? { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight } : null;
  },

  /** 顶部插入历史后，按高度增量补偿 scrollTop，使原先可见的消息保持不动。 */
  restoreAfterPrepend(snapshot: ScrollSnapshot | null) {
    if (!element || !snapshot) return;
    element.scrollTop = snapshot.scrollTop + (element.scrollHeight - snapshot.scrollHeight);
  },

  scrollToBottom() {
    if (element) element.scrollTop = element.scrollHeight;
  },

  /** 定位到指定消息（相册内任一消息也可）；找不到返回 false，由调用方回退到贴底。用几何矩形计算，不依赖 offsetParent 层级。 */
  scrollToMessage(messageId: number, center = false): boolean {
    const target = element?.querySelector<HTMLElement>(`[data-message-id="${messageId}"], [data-album-ids~="${messageId}"]`);
    if (!element || !target) return false;
    const paddingTop = center ? Math.max(16, Math.floor(element.clientHeight * 0.22)) : 12;
    element.scrollTop += target.getBoundingClientRect().top - element.getBoundingClientRect().top - paddingTop;
    return true;
  },

  attachComposerInput(target: Element | null) {
    composerInput = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
  },

  focusComposerInput() {
    composerInput?.focus();
  },

  /** 视口顶部第一条可见消息的 ID，用于离开会话后恢复阅读位置。 */
  topVisibleMessageId(): number | null {
    if (!element) return null;
    const top = element.getBoundingClientRect().top;
    const nodes = element.querySelectorAll<HTMLElement>('[data-message-id]');
    for (const node of nodes) {
      if (node.getBoundingClientRect().bottom > top) return Number(node.dataset.messageId);
    }
    return null;
  },
};
