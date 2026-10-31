/**
 * [DATA SOURCE] 视频播放句柄
 *
 * HTMLVideoElement、全屏容器、画中画状态都是不可序列化的 DOM 句柄：统一登记在此单例，
 * 视图通过 v-video-element / v-video-stage 指令挂载，Store 只拿到纯数据状态并通过这里下发指令。
 *
 * slot 命名：'viewer'（查看器）、`gif:${target}`（气泡内 GIF）、`round:${target}`（圆形视频）。
 */
export interface PlaybackPatch {
  attached?: boolean;
  paused?: boolean;
  ended?: boolean;
  currentTime?: number;
  duration?: number;
  /** 已缓冲区间（秒）。 */
  buffered?: [number, number][];
  waiting?: boolean;
  error?: 'unsupported' | 'decode' | 'network' | null;
  pip?: boolean;
}

export interface PlaybackConfig { muted: boolean; volume: number; rate: number; loop: boolean }

type PlaybackHandler = (slot: string, patch: PlaybackPatch) => void;
type FullscreenHandler = (fullscreen: boolean) => void;
type PageHandler = (visible: boolean) => void;

interface SlotRecord { element: HTMLVideoElement; detach: () => void }

/** timeupdate 节流到约 4 Hz（参考实现 SeekLine 的 250 ms）。 */
const TIME_THROTTLE_MS = 250;

const slots = new Map<string, SlotRecord>();
let handler: PlaybackHandler | null = null;
let fullscreenHandler: FullscreenHandler | null = null;
let pageHandler: PageHandler | null = null;
let stage: HTMLElement | null = null;
let globalListenersBound = false;

function bufferedOf(element: HTMLVideoElement): [number, number][] {
  const ranges: [number, number][] = [];
  for (let index = 0; index < element.buffered.length; index += 1) ranges.push([element.buffered.start(index), element.buffered.end(index)]);
  return ranges;
}

function errorKind(element: HTMLVideoElement): PlaybackPatch['error'] {
  const code = element.error?.code;
  if (code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) return 'unsupported';
  if (code === MediaError.MEDIA_ERR_DECODE) return 'decode';
  if (code === MediaError.MEDIA_ERR_NETWORK) return 'network';
  return code ? 'decode' : null;
}

function fullscreenElement(): Element | null {
  const doc = document as Document & { webkitFullscreenElement?: Element | null };
  return document.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function bindGlobalListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;
  const notifyFullscreen = () => fullscreenHandler?.(Boolean(stage && fullscreenElement() === stage));
  document.addEventListener('fullscreenchange', notifyFullscreen);
  document.addEventListener('webkitfullscreenchange', notifyFullscreen);
  document.addEventListener('visibilitychange', () => pageHandler?.(document.visibilityState === 'visible'));
}

function emit(slot: string, patch: PlaybackPatch) { handler?.(slot, patch); }

export const videoPlayback = {
  onState(next: PlaybackHandler) { handler = next; bindGlobalListeners(); },
  onFullscreenChange(next: FullscreenHandler) { fullscreenHandler = next; bindGlobalListeners(); },
  onPageVisibility(next: PageHandler) { pageHandler = next; bindGlobalListeners(); },

  attach(slot: string, element: HTMLVideoElement) {
    const previous = slots.get(slot);
    if (previous?.element === element) return;
    previous?.detach();
    let lastTime = 0;
    const listeners: [string, () => void][] = [
      ['loadedmetadata', () => emit(slot, { duration: Number.isFinite(element.duration) ? element.duration : 0, error: null })],
      ['durationchange', () => emit(slot, { duration: Number.isFinite(element.duration) ? element.duration : 0 })],
      ['timeupdate', () => {
        const now = performance.now();
        if (now - lastTime < TIME_THROTTLE_MS) return;
        lastTime = now;
        emit(slot, { currentTime: element.currentTime });
      }],
      ['seeked', () => emit(slot, { currentTime: element.currentTime })],
      ['progress', () => emit(slot, { buffered: bufferedOf(element) })],
      ['play', () => emit(slot, { paused: false, ended: false })],
      ['playing', () => emit(slot, { paused: false, waiting: false, buffered: bufferedOf(element) })],
      ['pause', () => emit(slot, { paused: true, currentTime: element.currentTime })],
      ['waiting', () => emit(slot, { waiting: true })],
      ['canplay', () => emit(slot, { waiting: false, buffered: bufferedOf(element) })],
      ['ended', () => emit(slot, { ended: true, paused: true, currentTime: element.duration || element.currentTime })],
      ['error', () => emit(slot, { error: errorKind(element), paused: true })],
      ['enterpictureinpicture', () => emit(slot, { pip: true })],
      ['leavepictureinpicture', () => emit(slot, { pip: false })],
    ];
    listeners.forEach(([name, listener]) => element.addEventListener(name, listener));
    slots.set(slot, {
      element,
      detach: () => {
        listeners.forEach(([name, listener]) => element.removeEventListener(name, listener));
        if (document.pictureInPictureElement === element) void document.exitPictureInPicture().catch(() => undefined);
        element.pause();
      },
    });
    emit(slot, { attached: true, paused: true, ended: false, currentTime: 0, waiting: false, error: null, pip: false });
  },

  /** 元素卸载时调用：暂停、移除监听；仅当登记的仍是该元素时才清理（防止新旧元素交替时误删）。 */
  detach(slot: string, element?: HTMLVideoElement) {
    const record = slots.get(slot);
    if (!record || (element && record.element !== element)) return;
    record.detach();
    slots.delete(slot);
    emit(slot, { attached: false, paused: true });
  },

  has(slot: string) { return slots.has(slot); },

  configure(slot: string, config: Partial<PlaybackConfig>) {
    const element = slots.get(slot)?.element;
    if (!element) return;
    if (config.muted !== undefined) element.muted = config.muted;
    if (config.volume !== undefined) element.volume = Math.min(1, Math.max(0, config.volume));
    if (config.rate !== undefined) element.playbackRate = config.rate;
    if (config.loop !== undefined) element.loop = config.loop;
  },

  /** 'blocked'：浏览器自动播放策略拒绝（需要用户再点一次）。 */
  async play(slot: string): Promise<'ok' | 'blocked' | 'error' | 'missing'> {
    const element = slots.get(slot)?.element;
    if (!element) return 'missing';
    try {
      await element.play();
      return 'ok';
    } catch (error) {
      return (error as DOMException)?.name === 'NotAllowedError' ? 'blocked' : 'error';
    }
  },

  pause(slot: string) { slots.get(slot)?.element.pause(); },

  /** 暂停除 except 之外的所有 slot（圆形视频单实例、查看器播放时停掉气泡内有声播放）。 */
  pauseAll(filter: (slot: string) => boolean = () => true) {
    slots.forEach((record, slot) => { if (filter(slot)) record.element.pause(); });
  },

  seek(slot: string, time: number) {
    const element = slots.get(slot)?.element;
    if (!element) return;
    const duration = Number.isFinite(element.duration) ? element.duration : time;
    element.currentTime = Math.min(Math.max(0, time), duration);
    emit(slot, { currentTime: element.currentTime, ended: false });
  },

  currentTime(slot: string) { return slots.get(slot)?.element.currentTime ?? 0; },

  /** 浏览器预检：'' 表示确定不支持；quicktime 在 Chromium 返回 '' 但多数 H.264 .mov 可按 mp4 播放。 */
  canPlay(mimeType: string, codec?: string): CanPlayTypeResult {
    if (typeof document === 'undefined') return 'maybe';
    const probe = document.createElement('video');
    const codecs: Record<string, string> = { h264: 'avc1.42E01E', avc: 'avc1.42E01E', h265: 'hvc1.1.6.L93.B0', hevc: 'hvc1.1.6.L93.B0', av1: 'av01.0.05M.08', vp9: 'vp09.00.10.08' };
    const codecString = codec ? codecs[codec.toLowerCase()] : undefined;
    return probe.canPlayType(codecString ? `${mimeType}; codecs="${codecString}"` : mimeType);
  },

  // —— 全屏 / 画中画 ——
  attachStage(element: HTMLElement | null) { stage = element; bindGlobalListeners(); },

  isFullscreenSupported() {
    if (typeof document === 'undefined') return false;
    const doc = document as Document & { webkitFullscreenEnabled?: boolean };
    if (document.fullscreenEnabled || doc.webkitFullscreenEnabled) return true;
    return typeof HTMLVideoElement !== 'undefined' && 'webkitEnterFullscreen' in HTMLVideoElement.prototype;
  },

  /** 全屏对象是查看器舞台容器（自定义控制条与键盘仍然有效）；iOS 退回 video 原生全屏。 */
  async toggleFullscreen() {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    if (fullscreenElement()) { await (document.exitFullscreen?.() ?? doc.webkitExitFullscreen?.())?.catch?.(() => undefined); return; }
    const target = stage as (HTMLElement & { webkitRequestFullscreen?: () => Promise<void> }) | null;
    if (target?.requestFullscreen) { await target.requestFullscreen().catch(() => undefined); return; }
    if (target?.webkitRequestFullscreen) { await target.webkitRequestFullscreen(); return; }
    const video = slots.get('viewer')?.element as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | undefined;
    video?.webkitEnterFullscreen?.();
  },

  async exitFullscreen() {
    if (fullscreenElement()) await document.exitFullscreen?.().catch(() => undefined);
  },

  isPipSupported() {
    return typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled) && !/iPhone|iPad|iPod/i.test(navigator.userAgent);
  },

  async togglePip(slot: string) {
    const element = slots.get(slot)?.element;
    if (!element) return;
    try {
      if (document.pictureInPictureElement === element) await document.exitPictureInPicture();
      else await element.requestPictureInPicture();
    } catch { /* 浏览器拒绝时保持原状 */ }
  },
};
