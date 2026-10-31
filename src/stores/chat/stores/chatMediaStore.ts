/**
 * chat 域媒体状态（阶段 4：图片；阶段 5–6：视频缩略图与统一查看器）：
 * 缩略图 → 预览 → 原图的分级加载、可见性驱动的自动下载、照片 / 视频统一查看器（翻页、放大、胶片条）与本机媒体缓存。
 * 完整视频文件、播放状态与 GIF / 圆形视频的播放由 chatVideoStore 负责。
 *
 * 数据流：View（零 ref，v-media-visible 登记元素）→ messageViewport 可见性回调 → chatMediaStore
 *   → chatMediaLoader（去重 / 优先级 / 并发 / 退避）→ chatMediaCache（加密 Cache Storage）或 chatDataSource → 本地 Worker。
 * 消息、会话与账户仍以 chatStore 为唯一来源，本 Store 只读取，不复制。
 */
import { defineStore } from 'pinia';
import { effectScope, watch } from 'vue';
import { useChatStore } from './chatStore';
import { useChatVideoStore } from './chatVideoStore';
import { chatDataSource } from '../data-sources/chatDataSource';
import { chatMediaCache } from '../data-sources/chatMediaCache';
import { chatMediaLoader, MediaCanceledError } from '../data-sources/chatMediaLoader';
import { chatPreferences } from '../data-sources/chatPreferences';
import { messageViewport } from '../data-sources/messageViewport';
import { TgChatRequestError } from '@/stores/telegram/data-sources/mtprotoBridge';
import type { AutoDownloadPrefs, FeedPhoto, MediaEntry, TgMediaFile, TgMessageDto, TgPeerKey, TgPeerRef, TgPhotoInfo, TgPhotoSize } from '../types';
import { formatDateTime, initialsOf, mediaTarget, parseMediaTarget, photoKey, previewSizeOf, videoPreviewOf } from './chatModel';

const PRIORITY_VIEWER = 30;
const PRIORITY_MANUAL = 20;
const PRIORITY_VISIBLE = 10;
const PRIORITY_NEIGHBOR = 5;
const RETRYABLE_PATTERNS = ['TIMEOUT', 'DISCONNECT', 'CONNECTION', 'NETWORK'];
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.5;
/** 触屏横向滑动翻页的最小距离。 */
const SWIPE_DISTANCE = 60;
/** 指针移动超过该距离视为拖动，随后的 click 不再触发播放 / 关闭。 */
const DRAG_THRESHOLD = 6;

/** 模块作用域：可见集合、代次与指针跟踪不可序列化，不进入 Pinia state。 */
let initialized = false;
let mediaGeneration = 0;
const visibleTargets = new Set<string>();
const pointers = new Map<number, { x: number; y: number }>();
let gesture: { kind: 'pan' | 'swipe' | 'pinch'; startX: number; startY: number; originX: number; originY: number; distance: number; scale: number; moved: boolean } | null = null;
let suppressClick = false;

export interface MessageRef { peerKey: TgPeerKey; message: TgMessageDto }
interface ImageRequest { key: string; spoiler: boolean; fetch: (accountId: string, peer: TgPeerRef, messageId: number) => Promise<TgMediaFile> }

function isRetryable(error: unknown) {
  const raw = `${error instanceof TgChatRequestError ? error.code : ''} ${error instanceof Error ? error.message : ''}`.toUpperCase();
  return RETRYABLE_PATTERNS.some((pattern) => raw.includes(pattern));
}

function photoRequest(photo: TgPhotoInfo, size: TgPhotoSize, spoiler = Boolean(photo.spoiler)): ImageRequest {
  return { key: photoKey(photo, size), spoiler, fetch: (accountId, peer, messageId) => chatDataSource.getPhoto(accountId, peer, messageId, photo, size) };
}

/** 气泡 / 胶片条使用的预览图：照片取预览档，视频取封面或文档缩略图。 */
function previewRequestOf(message: TgMessageDto): ImageRequest | null {
  const photo = message.media?.photo;
  if (photo) return photoRequest(photo, previewSizeOf(photo));
  const video = message.media?.video;
  const source = video ? videoPreviewOf(video) : null;
  if (!video || !source) return null;
  if (source.kind === 'photo') return photoRequest(source.photo, source.size, Boolean(video.spoiler));
  return { key: source.key, spoiler: Boolean(video.spoiler), fetch: (accountId, peer, messageId) => chatDataSource.getDocumentThumb(accountId, peer, messageId, video, source.size) };
}

/** 查看器可翻页的媒体：照片与消息视频 / GIF（圆形视频与文件方式发送的视频除外）。 */
export function isViewerItem(message: TgMessageDto) {
  const media = message.media;
  if (media?.photo) return true;
  return Boolean(media?.video && !media.video.asFile && (media.kind === 'video' || media.kind === 'gif'));
}

function viewerItemsOf(viewer: { peerKey: TgPeerKey; messageId: number; single: boolean }): TgMessageDto[] {
  const messages = useChatStore().windows[viewer.peerKey]?.messages ?? [];
  if (viewer.single) return messages.filter((message) => message.id === viewer.messageId);
  return messages.filter(isViewerItem);
}

export interface FilmstripItem { target: string; thumb?: string; url?: string; active: boolean; isVideo: boolean }

export interface MediaViewerModel {
  type: 'photo' | 'video' | 'gif';
  target: string;
  /** 照片：当前最清晰的可用地址。 */
  src?: string;
  /** 照片当前清晰度：thumb 为模糊占位，preview 为气泡预览档，full 为原图。 */
  quality: 'thumb' | 'preview' | 'full';
  isLoading: boolean;
  error: string | null;
  width: number;
  height: number;
  caption: string;
  title: string;
  initials: string;
  dateLabel: string;
  position: string;
  hasPrev: boolean;
  hasNext: boolean;
  /** 视频海报：封面 / 缩略图地址，未就绪时为 stripped thumb。 */
  posterUrl?: string;
  thumb?: string;
  filmstrip: FilmstripItem[] | null;
}

export const useChatMediaStore = defineStore('chatMedia', {
  state: () => ({
    /** key = `photo:${photoId}:${sizeType}` 或 `doc:${documentId}:${sizeType}`。 */
    entries: {} as Record<string, MediaEntry>,
    /** 用户已点开的防剧透媒体（按 target）。 */
    revealed: {} as Record<string, true>,
    /** 自动下载关闭时用户手动点选加载的媒体（按 target）。 */
    manual: {} as Record<string, true>,
    autoDownload: chatPreferences.readAutoDownload() as AutoDownloadPrefs,
    /** 查看器当前项；single 表示以文件方式发送的视频单独打开，不参与翻页。覆盖层属于 UI 态，不进路由。 */
    viewer: null as { peerKey: TgPeerKey; messageId: number; single: boolean } | null,
    /** 查看器放大与平移（px，相对舞台中心）。 */
    zoom: { scale: 1, x: 0, y: 0 },
    /** 最近一次指针类型：触屏上点击视频切换控制条而非播放。 */
    lastPointerType: 'mouse' as string,
    cacheUsage: null as { entries: number; bytes: number } | null,
    isClearingCache: false,
  }),

  getters: {
    cacheUsageLabel(state): string {
      const usage = state.cacheUsage;
      if (!usage) return '当前环境不支持本机媒体缓存，或尚未统计';
      const size = usage.bytes >= 1024 * 1024 ? `${(usage.bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(usage.bytes / 1024)} KB`;
      return `${usage.entries} 个文件 · ${size}`;
    },
    /** 查看器视图模型：照片优先显示原图，未就绪时退回预览图 / 模糊缩略图；视频的播放状态见 chatVideoStore.viewerVideo。 */
    viewerModel(state): MediaViewerModel | null {
      const viewer = state.viewer;
      if (!viewer) return null;
      const items = viewerItemsOf(viewer);
      const index = items.findIndex((message) => message.id === viewer.messageId);
      const message = items[index];
      if (!message?.media) return null;
      const dialog = useChatStore().dialogs[viewer.peerKey];
      const title = message.senderName || dialog?.title || '媒体';
      const base = {
        target: mediaTarget(viewer.peerKey, message.id),
        caption: message.text,
        title,
        initials: initialsOf(dialog?.title ?? title),
        dateLabel: formatDateTime(message.date),
        position: `${index + 1} / ${items.length}`,
        hasPrev: index > 0,
        hasNext: index < items.length - 1,
        filmstrip: filmstripOf(state.entries, viewer.peerKey, items, message),
      };
      const photo = message.media.photo;
      if (photo) {
        const preview = state.entries[photoKey(photo, previewSizeOf(photo))];
        const full = state.entries[photoKey(photo, photo.full)];
        return {
          ...base,
          type: 'photo',
          src: full?.url ?? preview?.url ?? photo.thumb,
          quality: full?.url ? 'full' : preview?.url ? 'preview' : 'thumb',
          isLoading: !full?.url && full?.status !== 'error',
          error: full?.status === 'error' ? full.error ?? '原图加载失败' : null,
          width: photo.width,
          height: photo.height,
        };
      }
      const video = message.media.video!;
      const previewKey = videoPreviewOf(video)?.key;
      const thumb = video.cover?.thumb ?? video.thumb;
      return {
        ...base,
        type: message.media.kind === 'gif' ? 'gif' : 'video',
        quality: 'full',
        isLoading: false,
        error: null,
        width: video.width || 1280,
        height: video.height || 720,
        posterUrl: (previewKey ? state.entries[previewKey]?.url : undefined) ?? thumb,
        thumb,
      };
    },
    /** 放大后的舞台 transform。 */
    zoomStyle(state): Record<string, string> | undefined {
      const { scale, x, y } = state.zoom;
      return scale === 1 ? undefined : { transform: `translate3d(${x}px, ${y}px, 0) scale(${scale})` };
    },
  },

  actions: {
    /** 幂等：注册可见性回调与 URL 淘汰回调；账户切换时的回收由 chatStore.resetContent 调用 reset 完成。 */
    init() {
      if (initialized) return;
      initialized = true;
      const chat = useChatStore();
      messageViewport.onMediaVisibility((target, visible) => this.handleVisibility(target, visible));
      chatMediaLoader.onEvict((key) => {
        if (this.entries[key]) delete this.entries[key];
        else useChatVideoStore().handleEvict(key);
      });
      useChatVideoStore().init();
      effectScope(true).run(() => {
        // 切换会话时关闭查看器，避免覆盖层停留在已离开的聊天上。
        watch(() => chat.activeChatKey, (key) => { if (this.viewer && this.viewer.peerKey !== key) this.closeViewer(); });
        // 连接恢复后重新请求仍在视口内、此前因断线失败的媒体。
        watch(() => chat.isOnline, (online) => {
          if (!online) return;
          this.retryVisible();
          if (this.viewer) this.loadViewerAssets();
        });
      });
    },

    reset() {
      mediaGeneration += 1;
      useChatVideoStore().reset();
      chatMediaLoader.reset();
      visibleTargets.clear();
      this.entries = {};
      this.revealed = {};
      this.manual = {};
      this.viewer = null;
      this.zoom = { scale: 1, x: 0, y: 0 };
    },

    resolve(target: string): MessageRef | null {
      const parsed = parseMediaTarget(target);
      if (!parsed) return null;
      const message = useChatStore().windows[parsed.peerKey]?.messages.find((item) => item.id === parsed.messageId);
      return message?.media ? { peerKey: parsed.peerKey, message } : null;
    },

    allowsAutoDownload(peerKey: TgPeerKey): boolean {
      const kind = useChatStore().dialogs[peerKey]?.kind;
      if (kind === 'channel') return this.autoDownload.channel;
      if (kind === 'group' || kind === 'supergroup') return this.autoDownload.group;
      return this.autoDownload.private;
    },

    /** 气泡内单个媒体的预览图展示态（模板中调用，按 previewKey / target 精确追踪依赖）。 */
    tileState(photo: FeedPhoto): 'ready' | 'loading' | 'error' | 'spoiler' | 'manual' | 'idle' {
      if (photo.spoiler && !this.revealed[photo.target]) return 'spoiler';
      const entry = photo.previewKey ? this.entries[photo.previewKey] : undefined;
      if (entry?.status === 'ready') return 'ready';
      if (entry?.status === 'error') return 'error';
      // 排队 / 读本机缓存阶段只显示模糊缩略图，真正走网络下载时才出现加载指示，避免缓存命中时闪烁。
      if (entry?.status === 'loading') return 'loading';
      if (entry || !photo.previewKey) return 'idle';
      const peerKey = parseMediaTarget(photo.target)?.peerKey;
      return peerKey && !this.manual[photo.target] && !this.allowsAutoDownload(peerKey) ? 'manual' : 'idle';
    },

    previewUrl(previewKey: string): string | undefined {
      return previewKey ? this.entries[previewKey]?.url : undefined;
    },

    /** 进入预取范围：按自动下载策略请求预览图（GIF / 圆形视频另由视频 Store 决定是否预载）；离开：取消尚未开始的下载。 */
    handleVisibility(target: string, visible: boolean) {
      useChatVideoStore().handleVisibility(target, visible);
      const ref = this.resolve(target);
      const request = ref ? previewRequestOf(ref.message) : null;
      if (!visible) {
        visibleTargets.delete(target);
        if (request && this.entries[request.key]?.status === 'queued' && chatMediaLoader.cancel(request.key)) delete this.entries[request.key];
        return;
      }
      visibleTargets.add(target);
      if (!ref || !request) return;
      if (this.entries[request.key]?.status === 'ready') { chatMediaLoader.touch(request.key); return; }
      if (request.spoiler && !this.revealed[target]) return;
      if (!this.manual[target] && !this.allowsAutoDownload(ref.peerKey)) return;
      this.requestImage(ref, request, PRIORITY_VISIBLE);
    },

    retryVisible() {
      visibleTargets.forEach((target) => {
        const ref = this.resolve(target);
        const request = ref ? previewRequestOf(ref.message) : null;
        if (request && this.entries[request.key]?.status === 'error') delete this.entries[request.key];
        this.handleVisibility(target, true);
      });
    },

    requestImage(ref: MessageRef, request: ImageRequest, priority: number) {
      const chat = useChatStore();
      const accountId = chat.accountId;
      const ownerId = chat.ownerId;
      const peer = chat.peerRefOf(ref.peerKey);
      const key = request.key;
      const current = this.entries[key];
      if (!accountId || !ownerId || !peer || current?.status === 'ready' || current?.status === 'loading') return;
      if (current?.status !== 'queued') this.entries[key] = { status: 'queued' };
      const generation = mediaGeneration;
      const scope = chatMediaCache.scopeOf(ownerId, accountId);
      const fetch = async () => {
        const cached = await chatMediaCache.read(scope, key);
        if (cached) return cached;
        // 冷启动仅有缓存 / 断线时不发起网络下载：按取消处理回到空闲态，连接恢复后由 retryVisible 重新请求可见媒体。
        if (!chat.isOnline) throw new MediaCanceledError();
        if (generation === mediaGeneration && this.entries[key]?.status === 'queued') this.entries[key] = { status: 'loading' };
        const file = await request.fetch(accountId, peer, ref.message.id);
        void chatMediaCache.write(scope, key, file.bytes, file.mimeType);
        return new Blob([file.bytes], { type: file.mimeType });
      };
      chatMediaLoader.load(key, { priority, fetch, isRetryable }).then(
        (url) => { if (generation === mediaGeneration) this.entries[key] = { status: 'ready', url }; },
        (error: unknown) => {
          if (generation !== mediaGeneration) return;
          if (error instanceof MediaCanceledError) { if (this.entries[key]?.status !== 'ready') delete this.entries[key]; return; }
          this.entries[key] = { status: 'error', error: chatDataSource.readError(error) };
        },
      );
    },

    requestPreview(ref: MessageRef, priority: number) {
      const request = previewRequestOf(ref.message);
      if (request) this.requestImage(ref, request, priority);
    },

    /** 气泡内点击：揭开防剧透遮罩 / 失败重试 / 手动加载预览；其余情况打开查看器（视频直接进入查看器并开始下载）。 */
    activateVisual(target: string) {
      const ref = this.resolve(target);
      if (!ref) return;
      const request = previewRequestOf(ref.message);
      const entry = request ? this.entries[request.key] : undefined;
      const isPhoto = Boolean(ref.message.media?.photo);
      if (request?.spoiler && !this.revealed[target]) {
        this.revealed[target] = true;
        this.requestImage(ref, request, PRIORITY_MANUAL);
        return;
      }
      if (request && entry?.status === 'error') {
        delete this.entries[request.key];
        this.requestImage(ref, request, PRIORITY_MANUAL);
        if (isPhoto) return;
      }
      if (isPhoto && request && !entry && !this.manual[target] && !this.allowsAutoDownload(ref.peerKey)) {
        this.manual[target] = true;
        this.requestImage(ref, request, PRIORITY_MANUAL);
        return;
      }
      this.openViewer(target);
    },

    openViewer(target: string, single = false) {
      const ref = this.resolve(target);
      if (!ref) return;
      this.viewer = { peerKey: ref.peerKey, messageId: ref.message.id, single: single || !isViewerItem(ref.message) };
      this.revealed[target] = true;
      this.resetZoom();
      this.loadViewerAssets();
    },

    /** 照片：预览档先行、原图随后；视频：先取海报，再由视频 Store 决定画质并下载。相邻项与胶片条预取预览图。 */
    loadViewerAssets() {
      const viewer = this.viewer;
      if (!viewer) return;
      const items = viewerItemsOf(viewer);
      const index = items.findIndex((message) => message.id === viewer.messageId);
      const current = items[index];
      if (!current?.media) return;
      const ref = { peerKey: viewer.peerKey, message: current };
      const photo = current.media.photo;
      if (photo) {
        const fullKey = photoKey(photo, photo.full);
        if (this.entries[fullKey]?.status === 'error') delete this.entries[fullKey];
        // 预览档体积小，先于原图返回，作为原图到达前的清晰占位。
        if (photo.preview) this.requestImage(ref, photoRequest(photo, photo.preview), PRIORITY_VIEWER + 1);
        this.requestImage(ref, photoRequest(photo, photo.full), PRIORITY_VIEWER);
      } else {
        const request = previewRequestOf(current);
        if (request && this.entries[request.key]?.status === 'error') delete this.entries[request.key];
        this.requestPreview(ref, PRIORITY_VIEWER + 1);
      }
      const neighbors = [items[index - 1], items[index + 1]];
      if (current.groupedId) neighbors.push(...items.filter((item) => item.groupedId === current.groupedId));
      for (const neighbor of neighbors) if (neighbor && neighbor !== current) this.requestPreview({ peerKey: viewer.peerKey, message: neighbor }, PRIORITY_NEIGHBOR);
      useChatVideoStore().syncViewer();
    },

    stepViewer(delta: -1 | 1) {
      const viewer = this.viewer;
      if (!viewer) return;
      const items = viewerItemsOf(viewer);
      const next = items[items.findIndex((message) => message.id === viewer.messageId) + delta];
      if (next) this.jumpViewer(mediaTarget(viewer.peerKey, next.id));
    },

    jumpViewer(target: string) {
      const viewer = this.viewer;
      const parsed = parseMediaTarget(target);
      if (!viewer || !parsed || parsed.peerKey !== viewer.peerKey || parsed.messageId === viewer.messageId) return;
      this.viewer = { ...viewer, messageId: parsed.messageId };
      this.revealed[target] = true;
      this.resetZoom();
      this.loadViewerAssets();
    },

    closeViewer() {
      this.viewer = null;
      this.resetZoom();
      useChatVideoStore().syncViewer();
    },

    /** 查看器下载按钮：照片保存原图；视频交给视频 Store（未下载时先下载再保存）。 */
    saveViewerMedia() {
      const model = this.viewerModel;
      const ref = model ? this.resolve(model.target) : null;
      if (!model || !ref) return;
      const photo = ref.message.media?.photo;
      if (photo) {
        const url = this.entries[photoKey(photo, photo.full)]?.url;
        if (url) chatMediaLoader.saveAs(url, `telegram-photo-${ref.message.id}.jpg`);
        return;
      }
      useChatVideoStore().saveViewerVideo();
    },

    /** 查看器键盘：视频项先交给视频 Store（播放 / seek / 全屏快捷键），其余为翻页。返回是否已处理。 */
    handleViewerKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [role="menu"]')) return;
      const isButton = Boolean(target?.closest('button'));
      // 焦点在按钮上时空格 / 回车属于按钮自身的激活，不再重复处理。
      if (isButton && (event.key === ' ' || event.key === 'Enter')) return;
      const model = this.viewerModel;
      let handled = false;
      if (model && model.type !== 'photo') handled = useChatVideoStore().handleKey(event.key);
      if (!handled && event.key === 'ArrowLeft') { this.stepViewer(-1); handled = true; }
      if (!handled && event.key === 'ArrowRight') { this.stepViewer(1); handled = true; }
      if (handled) event.preventDefault();
    },

    // —— 放大 / 平移 / 滑动翻页 ——
    resetZoom() { this.zoom = { scale: 1, x: 0, y: 0 }; },

    setZoom(scale: number, bounds?: { width: number; height: number }) {
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
      if (next === MIN_ZOOM) { this.resetZoom(); return; }
      this.zoom = { scale: next, ...this.clampPan(this.zoom.x, this.zoom.y, next, bounds) };
    },

    zoomIn() { this.setZoom(this.zoom.scale * ZOOM_STEP); },
    zoomOut() { this.setZoom(this.zoom.scale / ZOOM_STEP); },

    /** Ctrl / ⌘ + 滚轮缩放；普通滚轮不处理（交给说明文字滚动）。 */
    handleWheel(event: WheelEvent) {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
      this.setZoom(this.zoom.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), rect);
    },

    clampPan(x: number, y: number, scale: number, bounds?: { width: number; height: number }) {
      if (!bounds) return { x, y };
      const maxX = ((scale - 1) * bounds.width) / 2;
      const maxY = ((scale - 1) * bounds.height) / 2;
      return { x: Math.min(maxX, Math.max(-maxX, x)), y: Math.min(maxY, Math.max(-maxY, y)) };
    },

    stagePointerDown(event: PointerEvent) {
      this.lastPointerType = event.pointerType;
      // 控制条、按钮上的指针操作不参与平移 / 滑动。
      if ((event.target as HTMLElement | null)?.closest('[data-viewer-controls], button, input')) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      suppressClick = false;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        gesture = { kind: 'pinch', startX: 0, startY: 0, originX: this.zoom.x, originY: this.zoom.y, distance: Math.hypot(a.x - b.x, a.y - b.y), scale: this.zoom.scale, moved: true };
        return;
      }
      gesture = {
        kind: this.zoom.scale > 1 ? 'pan' : 'swipe',
        startX: event.clientX,
        startY: event.clientY,
        originX: this.zoom.x,
        originY: this.zoom.y,
        distance: 0,
        scale: this.zoom.scale,
        moved: false,
      };
      if (gesture.kind === 'pan') (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    },

    stagePointerMove(event: PointerEvent) {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const rect = (event.currentTarget as HTMLElement | null)?.getBoundingClientRect();
      if (gesture.kind === 'pinch' && pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const ratio = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, gesture.distance);
        this.setZoom(gesture.scale * ratio, rect);
        return;
      }
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) gesture.moved = true;
      if (gesture.kind === 'pan' && gesture.moved) this.zoom = { scale: this.zoom.scale, ...this.clampPan(gesture.originX + dx, gesture.originY + dy, this.zoom.scale, rect) };
    },

    stagePointerUp(event: PointerEvent) {
      if (!pointers.delete(event.pointerId) || !gesture) return;
      const current = gesture;
      if (current.moved) suppressClick = true;
      if (current.kind === 'swipe' && current.moved && event.pointerType !== 'mouse') {
        const dx = event.clientX - current.startX;
        const dy = event.clientY - current.startY;
        if (Math.abs(dx) > SWIPE_DISTANCE && Math.abs(dy) < Math.abs(dx) * 0.6) this.stepViewer(dx < 0 ? 1 : -1);
      }
      if (pointers.size === 0) gesture = null;
    },

    /** 拖动 / 滑动之后浏览器仍会派发 click：消费一次标记以免误触发播放或关闭。 */
    consumeDragClick(): boolean {
      const value = suppressClick;
      suppressClick = false;
      return value;
    },

    /** 点击舞台空白处关闭查看器（拖动后的 click 不算）。 */
    handleBackdropClick() {
      if (this.consumeDragClick()) return;
      if (this.zoom.scale > 1) { this.resetZoom(); return; }
      this.closeViewer();
    },

    setAutoDownload(kind: keyof AutoDownloadPrefs, enabled: boolean) {
      this.autoDownload = { ...this.autoDownload, [kind]: enabled };
      chatPreferences.writeAutoDownload(this.autoDownload);
      if (enabled) visibleTargets.forEach((target) => this.handleVisibility(target, true));
    },

    async refreshCacheUsage() {
      this.cacheUsage = await chatMediaCache.usage();
    },

    /** 只清除本机持久缓存；当前页面内已显示的媒体保留在内存中直到切换账户。 */
    async clearMediaCache() {
      if (this.isClearingCache) return;
      this.isClearingCache = true;
      try {
        await chatMediaCache.clearAll();
        await this.refreshCacheUsage();
      } finally {
        this.isClearingCache = false;
      }
    },
  },
});

function filmstripOf(entries: Record<string, MediaEntry>, peerKey: TgPeerKey, items: TgMessageDto[], current: TgMessageDto): FilmstripItem[] | null {
  if (!current.groupedId) return null;
  const album = items.filter((item) => item.groupedId === current.groupedId);
  if (album.length < 2) return null;
  return album.map((item) => {
    const request = previewRequestOf(item);
    const photo = item.media?.photo;
    const video = item.media?.video;
    return {
      target: mediaTarget(peerKey, item.id),
      thumb: photo?.thumb ?? video?.cover?.thumb ?? video?.thumb,
      url: request ? entries[request.key]?.url : undefined,
      active: item.id === current.id,
      isVideo: !photo,
    };
  });
}
