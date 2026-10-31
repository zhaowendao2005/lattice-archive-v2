/**
 * chat 域视频状态（阶段 5–6）：完整 Blob 下载与播放、查看器播放器控制、GIF 与圆形视频的气泡内播放。
 *
 * - 下载：chatMediaLoader 的 video 通道（并发受限、按字节淘汰、正在播放的 URL 钉住），字节进度写入 entries；
 * - 画质：自动在浏览器可播放的 altDocuments 中选择不超过 720p（或用户上限）的一档，大幅缩短 Blob 模式的等待；
 * - 播放：DOM 句柄全部在 videoPlayback 数据源，本 Store 只保存纯数据状态并下发指令；
 * - 大小策略：≤ 100 MB 直接下载，100–300 MB 需确认，> 300 MB 等待后续流式播放支持；
 * - 离开查看器 / 切换聊天：中断未完成的下载（主动保存的除外）。
 */
import { defineStore } from 'pinia';
import { effectScope, watch } from 'vue';
import { useChatStore } from './chatStore';
import { useChatMediaStore } from './chatMediaStore';
import { chatDataSource } from '../data-sources/chatDataSource';
import { chatMediaLoader, MediaCanceledError } from '../data-sources/chatMediaLoader';
import { chatPreferences } from '../data-sources/chatPreferences';
import { messageViewport } from '../data-sources/messageViewport';
import { videoPlayback, type PlaybackPatch } from '../data-sources/videoPlayback';
import { TgChatRequestError } from '@/stores/telegram/data-sources/mtprotoBridge';
import type { AutoplayPrefs, PlaybackState, PlayerPrefs, TgMessageDto, TgPeerKey, TgVideoInfo, TgVideoQuality, VideoEntry } from '../types';
import { chooseQuality, formatBytes, formatDuration, mediaTarget, parseMediaTarget, qualityHeight, qualityLabel, videoFileKey } from './chatModel';

const MB = 1024 * 1024;
export const VIDEO_DIRECT_LIMIT = 100 * MB;
export const VIDEO_CONFIRM_LIMIT = 300 * MB;
/** GIF / 圆形视频气泡内自动预载的大小上限。 */
const INLINE_AUTO_LIMIT = 10 * MB;
/** 时长不超过 30 s 的视频在查看器中循环（参考实现 MAX_LOOP_DURATION）。 */
const LOOP_MAX_DURATION = 30;
const HIDE_CONTROLS_MS = 3_000;
const SEEK_STEP = 5;
const RATES = [0.5, 1, 1.5, 2] as const;
const PRIORITY_VIEWER = 30;
const PRIORITY_MANUAL = 20;
const PRIORITY_AUTO = 10;
const RETRYABLE_PATTERNS = ['TIMEOUT', 'DISCONNECT', 'CONNECTION', 'NETWORK'];

/** 模块作用域：计时器、可见集合与当前查看器下载不可序列化，不进入 Pinia state。 */
let initialized = false;
let generation = 0;
let hideTimer: number | undefined;
let viewerKey: string | null = null;
let pageVisible = true;
/** 处于播放可见范围（≥ 50% 在视口内）的 GIF / 圆形视频。 */
const playbackVisible = new Set<string>();

const DEFAULT_PLAYBACK: PlaybackState = { attached: false, paused: true, ended: false, currentTime: 0, duration: 0, buffered: [], waiting: false, error: null, pip: false, blocked: false };

interface VideoRef { peerKey: TgPeerKey; message: TgMessageDto; video: TgVideoInfo; kind: 'video' | 'gif' | 'round' | 'file' }

function isRetryable(error: unknown) {
  const raw = `${error instanceof TgChatRequestError ? error.code : ''} ${error instanceof Error ? error.message : ''}`.toUpperCase();
  return RETRYABLE_PATTERNS.some((pattern) => raw.includes(pattern));
}

function resolveVideo(target: string): VideoRef | null {
  const parsed = parseMediaTarget(target);
  if (!parsed) return null;
  const message = useChatStore().windows[parsed.peerKey]?.messages.find((item) => item.id === parsed.messageId);
  const media = message?.media;
  if (!message || !media?.video) return null;
  const kind = media.video.asFile ? 'file' : media.kind === 'gif' ? 'gif' : media.kind === 'round' ? 'round' : 'video';
  return { peerKey: parsed.peerKey, message, video: media.video, kind };
}

/** quicktime 在 Chromium 上 canPlayType 为空，但多数 H.264 .mov 按 mp4 解码即可。 */
function blobTypeOf(mimeType: string) {
  if (mimeType === 'video/quicktime' && videoPlayback.canPlay('video/quicktime') === '') return 'video/mp4';
  return mimeType;
}

function isPlayable(quality: TgVideoQuality) {
  if (quality.mimeType === 'video/quicktime') return true;
  return videoPlayback.canPlay(quality.mimeType, quality.codec) !== '';
}

function screenHeight() {
  return typeof window === 'undefined' ? 720 : Math.round(Math.min(window.screen.width, window.screen.height) * (window.devicePixelRatio || 1));
}

/** 当前生效画质：用户手动选择优先，否则按偏好上限自动选择。 */
function pickQuality(selected: Record<string, string>, player: PlayerPrefs, target: string, video: TgVideoInfo): TgVideoQuality {
  const manual = selected[target];
  const chosen = manual ? video.qualities.find((item) => item.id === manual) : undefined;
  return chosen ?? chooseQuality(video, isPlayable, player.maxHeight, screenHeight());
}

function slotOf(kind: VideoRef['kind'], target: string) {
  return kind === 'gif' ? `gif:${target}` : kind === 'round' ? `round:${target}` : 'viewer';
}

export interface QualityOption { id: string; label: string; sizeLabel: string; active: boolean }

export interface ViewerVideoModel {
  target: string;
  kind: 'video' | 'gif' | 'file';
  key: string;
  status: 'confirm' | 'too-large' | 'unsupported' | 'idle' | 'queued' | 'loading' | 'ready' | 'error';
  percent: number;
  progressLabel: string;
  sizeLabel: string;
  url?: string;
  error?: string;
  loop: boolean;
  playback: PlaybackState;
  timeLabel: string;
  playedPercent: number;
  /** 已缓冲区间（百分比）：[起点, 宽度]。 */
  buffered: [number, number][];
  qualities: QualityOption[] | null;
  qualityLabel: string;
  saving: boolean;
  fileName: string;
}

export interface InlineVideoModel { url?: string; status: 'idle' | 'queued' | 'loading' | 'ready' | 'error'; percent: number; playing: boolean; active: boolean; progress: number }

export const useChatVideoStore = defineStore('chatVideo', {
  state: () => ({
    /** key = `video:${documentId}`（按画质文档区分）。 */
    entries: {} as Record<string, VideoEntry>,
    /** slot → 播放状态。 */
    playback: {} as Record<string, PlaybackState>,
    /** 100–300 MB 已确认下载的视频（按 target）。 */
    confirmed: {} as Record<string, true>,
    /** 用户在画质菜单中手动选择的版本（target → 文档 ID）。 */
    selectedQuality: {} as Record<string, string>,
    /** 下载完成后自动保存（按视频键）。 */
    saveRequested: {} as Record<string, true>,
    /** 用户手动点选加载的 GIF / 圆形视频（自动播放关闭或超过自动上限时）。 */
    manualInline: {} as Record<string, true>,
    /** 已下载但浏览器无法解码的视频（按视频键）：元素移除后仍保持「不支持」状态，避免反复挂载。 */
    undecodable: {} as Record<string, true>,
    /** 切换画质后在新元素挂载时恢复的播放位置（slot → 秒）。 */
    resumeAt: {} as Record<string, number>,
    autoplay: chatPreferences.readAutoplay() as AutoplayPrefs,
    player: chatPreferences.readPlayer() as PlayerPrefs,
    controlsVisible: true,
    pointerOnControls: false,
    /** 拖动进度条时的预览位置（0–1）；null 表示未拖动。 */
    seekPreview: null as number | null,
    hoverPreview: null as number | null,
    menu: null as 'rate' | 'quality' | null,
    isFullscreen: false,
    /** 正在有声播放的圆形视频（单实例）。 */
    activeRound: null as string | null,
    /** 设备能力（init 时探测一次）：iOS 不允许脚本调节音量，也不提供标准画中画 / 元素全屏。 */
    caps: { pip: false, fullscreen: false, volume: true },
  }),

  getters: {
    /** 进度条悬停 / 拖动时的时间提示。 */
    hoverLabel(state): string | null {
      const fraction = state.seekPreview ?? state.hoverPreview;
      const duration = state.playback.viewer?.duration ?? 0;
      return fraction === null || duration <= 0 ? null : formatDuration(fraction * duration);
    },
    viewerVideo(state): ViewerVideoModel | null {
      const media = useChatMediaStore();
      const viewer = media.viewer;
      if (!viewer) return null;
      const target = mediaTarget(viewer.peerKey, viewer.messageId);
      const ref = resolveVideo(target);
      if (!ref || ref.kind === 'round') return null;
      const quality = pickQuality(state.selectedQuality, state.player, target, ref.video);
      const key = videoFileKey(quality);
      const entry = state.entries[key];
      const playback = state.playback.viewer ?? DEFAULT_PLAYBACK;
      const duration = playback.duration || ref.video.duration;
      let status: ViewerVideoModel['status'] = entry?.status ?? 'idle';
      if (!entry) {
        if (!isPlayable(quality)) status = 'unsupported';
        else if (quality.size > VIDEO_CONFIRM_LIMIT) status = 'too-large';
        else if (quality.size > VIDEO_DIRECT_LIMIT && !state.confirmed[target]) status = 'confirm';
      }
      if (entry?.status === 'ready' && state.undecodable[key]) status = 'unsupported';
      const total = entry?.total || quality.size;
      const loaded = entry?.status === 'ready' ? total : entry?.loaded ?? 0;
      const current = state.seekPreview !== null ? state.seekPreview * duration : playback.currentTime;
      const options = ref.kind === 'video' && ref.video.qualities.length > 1
        ? ref.video.qualities.filter(isPlayable).map((item) => ({ id: item.id, label: qualityLabel(item), sizeLabel: formatBytes(item.size), active: item.id === quality.id }))
        : null;
      const manual = state.selectedQuality[target];
      return {
        target,
        kind: ref.kind === 'gif' ? 'gif' : ref.kind === 'file' ? 'file' : 'video',
        key,
        status,
        percent: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0,
        progressLabel: `${formatBytes(loaded)} / ${formatBytes(total)}`,
        sizeLabel: formatBytes(quality.size),
        url: entry?.url,
        error: entry?.error,
        loop: ref.kind === 'gif' || (duration > 0 && duration <= LOOP_MAX_DURATION),
        playback,
        timeLabel: `${formatDuration(current)} / ${formatDuration(duration)}`,
        playedPercent: duration > 0 ? Math.min(100, (current / duration) * 100) : 0,
        buffered: duration > 0 ? playback.buffered.map(([start, end]) => [(start / duration) * 100, ((end - start) / duration) * 100]) : [],
        qualities: options && options.length > 1 ? options : null,
        qualityLabel: manual ? qualityLabel(quality) : `自动（${qualityLabel(quality)}）`,
        saving: Boolean(state.saveRequested[key]) && entry?.status !== 'ready',
        fileName: ref.video.fileName || `telegram-video-${ref.message.id}.${quality.mimeType.split('/')[1] ?? 'mp4'}`,
      };
    },
  },

  actions: {
    init() {
      if (initialized) return;
      initialized = true;
      const chat = useChatStore();
      this.caps = {
        pip: videoPlayback.isPipSupported(),
        fullscreen: videoPlayback.isFullscreenSupported(),
        volume: typeof navigator === 'undefined' || !/iPhone|iPad|iPod/i.test(navigator.userAgent),
      };
      videoPlayback.onState((slot, patch) => this.handlePlayback(slot, patch));
      videoPlayback.onFullscreenChange((fullscreen) => { this.isFullscreen = fullscreen; this.pokeControls(); });
      videoPlayback.onPageVisibility((visible) => this.handlePageVisibility(visible));
      messageViewport.onPlaybackVisibility((target, visible) => this.handlePlaybackVisibility(target, visible));
      effectScope(true).run(() => {
        // 切换会话：有声播放中的圆形视频随之停止（元素卸载时数据源也会暂停）。
        watch(() => chat.activeChatKey, () => { this.activeRound = null; playbackVisible.clear(); });
      });
    },

    reset() {
      generation += 1;
      window.clearTimeout(hideTimer);
      viewerKey = null;
      playbackVisible.clear();
      void videoPlayback.exitFullscreen();
      this.entries = {};
      this.playback = {};
      this.confirmed = {};
      this.selectedQuality = {};
      this.saveRequested = {};
      this.undecodable = {};
      this.manualInline = {};
      this.resumeAt = {};
      this.seekPreview = null;
      this.hoverPreview = null;
      this.menu = null;
      this.activeRound = null;
      this.controlsVisible = true;
    },

    handleEvict(key: string) { if (this.entries[key]) delete this.entries[key]; },

    qualityFor(target: string, video: TgVideoInfo): TgVideoQuality {
      return pickQuality(this.selectedQuality, this.player, target, video);
    },

    /** 请求完整视频文件（video 通道）；进度写入 entries，完成后按需自动保存。 */
    requestVideo(ref: VideoRef, quality: TgVideoQuality, priority: number) {
      const chat = useChatStore();
      const accountId = chat.accountId;
      const peer = chat.peerRefOf(ref.peerKey);
      const key = videoFileKey(quality);
      const current = this.entries[key];
      if (!accountId || !peer || current?.status === 'ready' || current?.status === 'loading' || current?.status === 'queued') return;
      this.entries[key] = { status: 'queued', loaded: 0, total: quality.size };
      const taskGeneration = generation;
      const fetch = async ({ signal, onProgress }: { signal: AbortSignal; onProgress: (loaded: number, total: number) => void }) => {
        if (!chat.isOnline) throw new MediaCanceledError();
        if (taskGeneration === generation && this.entries[key]?.status === 'queued') this.entries[key] = { status: 'loading', loaded: 0, total: quality.size };
        const file = await chatDataSource.getDocument(accountId, peer, ref.message.id, quality, { signal, onProgress });
        return new Blob([file.bytes], { type: blobTypeOf(file.mimeType) });
      };
      const onProgress = (loaded: number, total: number) => {
        if (taskGeneration !== generation) return;
        const entry = this.entries[key];
        if (entry && entry.status !== 'ready') this.entries[key] = { status: 'loading', loaded, total };
      };
      chatMediaLoader.load(key, { lane: 'video', priority, fetch, isRetryable, onProgress }).then(
        (url) => {
          if (taskGeneration !== generation) return;
          this.entries[key] = { status: 'ready', loaded: quality.size, total: quality.size, url };
          if (key === viewerKey) chatMediaLoader.pin(key);
          if (this.saveRequested[key]) {
            delete this.saveRequested[key];
            chatMediaLoader.saveAs(url, ref.video.fileName || `telegram-video-${ref.message.id}.${quality.mimeType.split('/')[1] ?? 'mp4'}`);
          }
        },
        (error: unknown) => {
          if (taskGeneration !== generation) return;
          delete this.saveRequested[key];
          if (error instanceof MediaCanceledError) { if (this.entries[key]?.status !== 'ready') delete this.entries[key]; return; }
          this.entries[key] = { status: 'error', loaded: 0, total: quality.size, error: chatDataSource.readError(error) };
        },
      );
    },

    // —— 查看器 ——

    /** 查看器当前项变化（打开 / 翻页 / 关闭）：中断离开项未完成的下载，开始新项的下载。 */
    syncViewer() {
      const model = useChatMediaStore().viewer;
      const target = model ? mediaTarget(model.peerKey, model.messageId) : null;
      const ref = target ? resolveVideo(target) : null;
      const nextKey = ref && ref.kind !== 'round' ? videoFileKey(this.qualityFor(target!, ref.video)) : null;
      if (viewerKey && viewerKey !== nextKey) this.releaseViewerKey(viewerKey);
      viewerKey = nextKey;
      this.seekPreview = null;
      this.menu = null;
      this.controlsVisible = true;
      if (!nextKey || !ref || !target) { void videoPlayback.exitFullscreen(); return; }
      // 查看器开始播放前，停掉气泡内有声播放的圆形视频。
      if (this.activeRound) this.stopRound();
      this.startViewerVideo(target);
    },

    releaseViewerKey(key: string) {
      chatMediaLoader.unpin(key);
      const entry = this.entries[key];
      if (entry && entry.status !== 'ready' && entry.status !== 'error' && !this.saveRequested[key]) {
        chatMediaLoader.abort(key);
        delete this.entries[key];
      }
    },

    startViewerVideo(target: string) {
      const ref = resolveVideo(target);
      if (!ref || ref.kind === 'round') return;
      const quality = this.qualityFor(target, ref.video);
      const key = videoFileKey(quality);
      if (this.entries[key]?.status === 'ready') { chatMediaLoader.pin(key); return; }
      if (!isPlayable(quality) || quality.size > VIDEO_CONFIRM_LIMIT) return;
      if (quality.size > VIDEO_DIRECT_LIMIT && !this.confirmed[target]) return;
      this.requestVideo(ref, quality, PRIORITY_VIEWER);
    },

    confirmLarge() {
      const model = this.viewerVideo;
      if (!model) return;
      this.confirmed[model.target] = true;
      this.startViewerVideo(model.target);
    },

    cancelViewerDownload() {
      const model = this.viewerVideo;
      if (!model) return;
      delete this.saveRequested[model.key];
      chatMediaLoader.abort(model.key);
      delete this.entries[model.key];
      delete this.confirmed[model.target];
    },

    retryViewer() {
      const model = this.viewerVideo;
      if (!model) return;
      if (this.entries[model.key]?.status === 'error') delete this.entries[model.key];
      const playback = this.playback.viewer;
      if (playback) this.playback.viewer = { ...playback, error: null };
      this.confirmed[model.target] = true;
      this.startViewerVideo(model.target);
    },

    /** 保存视频：已下载直接保存；未下载则先下载（不受大小确认限制，但仍受 300 MB 上限保护内存）。 */
    saveViewerVideo() {
      const model = this.viewerVideo;
      const ref = model ? resolveVideo(model.target) : null;
      if (!model || !ref) return;
      if (model.url) { chatMediaLoader.saveAs(model.url, model.fileName); return; }
      if (model.saving) { this.cancelViewerDownload(); return; }
      const quality = this.qualityFor(model.target, ref.video);
      if (quality.size > VIDEO_CONFIRM_LIMIT) return;
      this.saveRequested[model.key] = true;
      if (this.entries[model.key]?.status === 'error') delete this.entries[model.key];
      this.requestVideo(ref, quality, PRIORITY_VIEWER);
    },

    selectQuality(id: string) {
      const model = this.viewerVideo;
      this.menu = null;
      if (!model || model.qualities?.find((item) => item.active)?.id === id) return;
      const time = videoPlayback.currentTime('viewer');
      if (time > 0) this.resumeAt.viewer = time;
      this.selectedQuality[model.target] = id;
      // 画质偏好记为短边上限，后续视频自动选择不超过该档的版本。
      const ref = resolveVideo(model.target);
      const quality = ref?.video.qualities.find((item) => item.id === id);
      if (quality) { this.player = { ...this.player, maxHeight: qualityHeight(quality) }; chatPreferences.writePlayer(this.player); }
      this.confirmed[model.target] = true;
      this.syncViewer();
    },

    setAutoQuality() {
      const model = this.viewerVideo;
      this.menu = null;
      if (!model) return;
      const time = videoPlayback.currentTime('viewer');
      if (time > 0) this.resumeAt.viewer = time;
      delete this.selectedQuality[model.target];
      this.player = { ...this.player, maxHeight: 0 };
      chatPreferences.writePlayer(this.player);
      this.syncViewer();
    },

    // —— 播放状态 ——

    handlePlayback(slot: string, patch: PlaybackPatch) {
      if (patch.attached === false) {
        delete this.playback[slot];
        return;
      }
      const previous = this.playback[slot] ?? DEFAULT_PLAYBACK;
      const next: PlaybackState = { ...previous, ...patch, blocked: patch.paused === false ? false : previous.blocked } as PlaybackState;
      this.playback[slot] = next;
      if (patch.attached) { void this.onAttached(slot); return; }
      if (slot === 'viewer') {
        if ((patch.error === 'unsupported' || patch.error === 'decode') && viewerKey) this.undecodable[viewerKey] = true;
        if (patch.paused === false) this.pokeControls();
        if (patch.paused === true || patch.ended) this.showControls();
        if (patch.duration && this.resumeAt.viewer !== undefined) {
          videoPlayback.seek('viewer', this.resumeAt.viewer);
          delete this.resumeAt.viewer;
        }
        if (patch.ended && !this.viewerVideo?.loop) videoPlayback.seek('viewer', 0);
        return;
      }
      if (slot.startsWith('round:') && patch.ended) {
        const target = slot.slice('round:'.length);
        if (this.activeRound === target) this.stopRound();
      }
    },

    /** 元素挂载：下发偏好设置并按场景开始播放。 */
    async onAttached(slot: string) {
      if (slot === 'viewer') {
        const model = this.viewerVideo;
        const muted = model?.kind === 'gif' ? true : this.player.muted;
        videoPlayback.configure('viewer', { muted, volume: this.player.volume, rate: model?.kind === 'gif' ? 1 : this.player.rate, loop: Boolean(model?.loop) });
        const startAt = this.resumeAt.viewer ?? (model ? resolveVideo(model.target)?.video.startAt : undefined);
        if (startAt) { videoPlayback.seek('viewer', startAt); delete this.resumeAt.viewer; }
        const result = await videoPlayback.play('viewer');
        const state = this.playback.viewer;
        if (result === 'blocked' && state) this.playback.viewer = { ...state, blocked: true };
        return;
      }
      const target = slot.slice(slot.indexOf(':') + 1);
      const active = slot.startsWith('round:') && this.activeRound === target;
      videoPlayback.configure(slot, { muted: !active, loop: !active, rate: 1, volume: this.player.volume });
      if (active) { videoPlayback.seek(slot, 0); await videoPlayback.play(slot); return; }
      if (playbackVisible.has(target) && pageVisible) await videoPlayback.play(slot);
    },

    togglePlay(slot = 'viewer') {
      const state = this.playback[slot];
      if (!state?.attached) return;
      if (state.paused || state.ended) {
        if (state.ended) videoPlayback.seek(slot, 0);
        if (slot === 'viewer' && this.activeRound) this.stopRound();
        void videoPlayback.play(slot).then((result) => {
          const current = this.playback[slot];
          if (current) this.playback[slot] = { ...current, blocked: result === 'blocked' };
        });
      } else {
        videoPlayback.pause(slot);
      }
    },

    seekTo(time: number) { videoPlayback.seek('viewer', time); this.pokeControls(); },
    seekBy(delta: number) { this.seekTo(videoPlayback.currentTime('viewer') + delta); },

    // 进度条拖动：拖动中只更新预览位置，松开时才真正 seek。
    startSeek(fraction: number) { this.seekPreview = Math.min(1, Math.max(0, fraction)); this.showControls(); },
    moveSeek(fraction: number) { if (this.seekPreview !== null) this.seekPreview = Math.min(1, Math.max(0, fraction)); },
    endSeek(fraction?: number) {
      const value = fraction !== undefined ? Math.min(1, Math.max(0, fraction)) : this.seekPreview;
      this.seekPreview = null;
      const duration = this.playback.viewer?.duration || 0;
      if (value !== null && duration > 0) this.seekTo(value * duration);
    },
    setHoverPreview(fraction: number | null) { this.hoverPreview = fraction === null ? null : Math.min(1, Math.max(0, fraction)); },

    setRate(rate: number) {
      if (!RATES.includes(rate as typeof RATES[number])) return;
      this.player = { ...this.player, rate };
      chatPreferences.writePlayer(this.player);
      videoPlayback.configure('viewer', { rate });
      this.menu = null;
    },

    setVolume(volume: number) {
      const value = Math.min(1, Math.max(0, volume));
      this.player = { ...this.player, volume: value, muted: value === 0 };
      chatPreferences.writePlayer(this.player);
      videoPlayback.configure('viewer', { volume: value, muted: value === 0 });
    },

    toggleMute() {
      const muted = !this.player.muted;
      const volume = !muted && this.player.volume === 0 ? 1 : this.player.volume;
      this.player = { ...this.player, muted, volume };
      chatPreferences.writePlayer(this.player);
      videoPlayback.configure('viewer', { muted, volume });
    },

    toggleFullscreen() { void videoPlayback.toggleFullscreen(); },
    togglePip() { void videoPlayback.togglePip('viewer'); },
    toggleMenu(menu: 'rate' | 'quality') { this.menu = this.menu === menu ? null : menu; this.showControls(); },
    closeMenu() { this.menu = null; this.pokeControls(); },

    // —— 控制条显隐：桌面指针移动显示、离开舞台或静止 3 s 隐藏；暂停 / 拖动 / 菜单打开时常驻 ——

    isPlayingViewer() {
      const state = this.playback.viewer;
      return Boolean(state?.attached && !state.paused && !state.ended);
    },

    showControls() {
      window.clearTimeout(hideTimer);
      this.controlsVisible = true;
    },

    pokeControls() {
      this.showControls();
      if (!this.isPlayingViewer() || this.seekPreview !== null || this.menu) return;
      hideTimer = window.setTimeout(() => {
        if (this.pointerOnControls) { this.pokeControls(); return; }
        if (this.isPlayingViewer() && this.seekPreview === null && !this.menu) this.controlsVisible = false;
      }, HIDE_CONTROLS_MS);
    },

    pointerLeftStage() {
      if (this.isPlayingViewer() && this.seekPreview === null && !this.menu) {
        window.clearTimeout(hideTimer);
        this.controlsVisible = false;
      }
    },

    setPointerOnControls(inside: boolean) { this.pointerOnControls = inside; if (inside) this.showControls(); else this.pokeControls(); },

    /** 点击视频画面：桌面切换播放；触屏切换控制条（与参考实现一致）。 */
    handleVideoClick() {
      const media = useChatMediaStore();
      if (media.consumeDragClick()) return;
      if (media.lastPointerType === 'touch') {
        if (this.controlsVisible && this.isPlayingViewer()) { window.clearTimeout(hideTimer); this.controlsVisible = false; } else this.pokeControls();
        return;
      }
      this.togglePlay('viewer');
    },

    handleVideoDoubleClick() {
      if (useChatMediaStore().lastPointerType === 'touch') return;
      this.toggleFullscreen();
    },

    /** 键盘：空格 / Enter / K 播放暂停，J / L ±5 s，M 静音，F 全屏；←/→ 仅在全屏时 seek（非全屏交给翻页）。 */
    handleKey(key: string): boolean {
      const model = this.viewerVideo;
      if (!model || this.playback.viewer?.pip) return false;
      const lower = key.toLowerCase();
      if (model.kind === 'gif') return false;
      if (key === ' ' || key === 'Enter' || lower === 'k') { this.togglePlay('viewer'); this.pokeControls(); return true; }
      if (lower === 'j') { this.seekBy(-SEEK_STEP); return true; }
      if (lower === 'l') { this.seekBy(SEEK_STEP); return true; }
      if (lower === 'm') { this.toggleMute(); this.pokeControls(); return true; }
      if (lower === 'f') { this.toggleFullscreen(); return true; }
      if (this.isFullscreen && key === 'ArrowLeft') { this.seekBy(-SEEK_STEP); return true; }
      if (this.isFullscreen && key === 'ArrowRight') { this.seekBy(SEEK_STEP); return true; }
      return false;
    },

    // —— GIF / 圆形视频（气泡内） ——

    inlineAllowed(ref: VideoRef): boolean {
      const media = useChatMediaStore();
      const target = mediaTarget(ref.peerKey, ref.message.id);
      if (this.manualInline[target]) return true;
      const enabled = ref.kind === 'gif' ? this.autoplay.gif : this.autoplay.round;
      return enabled && media.allowsAutoDownload(ref.peerKey) && ref.video.size <= INLINE_AUTO_LIMIT && !(ref.video.spoiler && !media.revealed[target]);
    },

    inlineKey(ref: VideoRef) { return videoFileKey(ref.video.qualities.find((item) => item.original) ?? ref.video); },

    /** 预取范围（600px）：满足自动播放条件的 GIF / 圆形视频提前下载；离开时取消尚未开始的下载。 */
    handleVisibility(target: string, visible: boolean) {
      const ref = resolveVideo(target);
      if (!ref || (ref.kind !== 'gif' && ref.kind !== 'round')) return;
      const key = this.inlineKey(ref);
      if (!visible) {
        if (this.entries[key]?.status === 'queued' && chatMediaLoader.cancel(key)) delete this.entries[key];
        return;
      }
      if (this.entries[key]?.status === 'ready') { chatMediaLoader.touch(key); return; }
      if (!this.inlineAllowed(ref)) return;
      this.requestVideo(ref, ref.video.qualities.find((item) => item.original) ?? ref.video.qualities[0], PRIORITY_AUTO);
    },

    /** 播放可见范围（≥ 50% 在视口内）：进入播放、离开暂停；有声播放的圆形视频离开视口时停止。 */
    handlePlaybackVisibility(target: string, visible: boolean) {
      const ref = resolveVideo(target);
      if (!ref || (ref.kind !== 'gif' && ref.kind !== 'round')) return;
      const slot = slotOf(ref.kind, target);
      if (visible) playbackVisible.add(target); else playbackVisible.delete(target);
      if (!visible) {
        if (this.activeRound === target) this.stopRound();
        videoPlayback.pause(slot);
        return;
      }
      if (pageVisible && this.playback[slot]?.attached) void videoPlayback.play(slot);
    },

    handlePageVisibility(visible: boolean) {
      pageVisible = visible;
      // 页面转入后台：暂停气泡内静音预览；回到前台：恢复仍在视口内的预览。
      videoPlayback.pauseAll((slot) => slot.startsWith('gif:') || (slot.startsWith('round:') && slot !== `round:${this.activeRound}`));
      if (!visible) return;
      playbackVisible.forEach((target) => {
        const ref = resolveVideo(target);
        if (ref && (ref.kind === 'gif' || ref.kind === 'round')) {
          const slot = slotOf(ref.kind, target);
          if (this.playback[slot]?.attached) void videoPlayback.play(slot);
        }
      });
    },

    inlineState(target: string): InlineVideoModel {
      const ref = resolveVideo(target);
      if (!ref) return { status: 'idle', percent: 0, playing: false, active: false, progress: 0 };
      const entry = this.entries[this.inlineKey(ref)];
      const playback = this.playback[slotOf(ref.kind, target)];
      const duration = playback?.duration || ref.video.duration;
      return {
        url: entry?.url,
        status: entry?.status ?? 'idle',
        percent: entry && entry.total > 0 ? Math.round((entry.loaded / entry.total) * 100) : 0,
        playing: Boolean(playback && !playback.paused),
        active: this.activeRound === target,
        progress: duration > 0 && playback ? Math.min(1, playback.currentTime / duration) : 0,
      };
    },

    /** 点击 GIF：未加载时手动加载；已加载则打开查看器。 */
    activateGif(target: string) {
      const ref = resolveVideo(target);
      if (!ref) return;
      const media = useChatMediaStore();
      if (ref.video.spoiler && !media.revealed[target]) { media.revealed[target] = true; }
      const key = this.inlineKey(ref);
      const entry = this.entries[key];
      if (entry?.status === 'queued' || entry?.status === 'loading') { chatMediaLoader.abort(key); delete this.entries[key]; return; }
      if (entry?.status !== 'ready') {
        this.manualInline[target] = true;
        if (entry?.status === 'error') delete this.entries[key];
        this.requestVideo(ref, ref.video.qualities.find((item) => item.original) ?? ref.video.qualities[0], PRIORITY_MANUAL);
        return;
      }
      media.openViewer(target);
    },

    /** 点击圆形视频：未加载先下载并在就绪后有声播放；已在有声播放则暂停 / 继续；否则从头有声播放并停掉其他有声播放。 */
    activateRound(target: string) {
      const ref = resolveVideo(target);
      if (!ref || ref.kind !== 'round') return;
      const slot = slotOf('round', target);
      const key = this.inlineKey(ref);
      const entry = this.entries[key];
      if (entry?.status === 'queued' || entry?.status === 'loading') {
        if (this.manualInline[target]) { chatMediaLoader.abort(key); delete this.entries[key]; delete this.manualInline[target]; this.activeRound = null; }
        else { this.manualInline[target] = true; this.activeRound = target; }
        return;
      }
      if (this.activeRound === target) {
        const state = this.playback[slot];
        if (state?.paused) void videoPlayback.play(slot); else videoPlayback.pause(slot);
        return;
      }
      if (this.activeRound) this.stopRound();
      videoPlayback.pauseAll((other) => other === 'viewer');
      this.activeRound = target;
      if (entry?.status !== 'ready') {
        this.manualInline[target] = true;
        if (entry?.status === 'error') delete this.entries[key];
        this.requestVideo(ref, ref.video.qualities.find((item) => item.original) ?? ref.video.qualities[0], PRIORITY_MANUAL);
        return;
      }
      videoPlayback.configure(slot, { muted: false, loop: false, volume: this.player.volume });
      videoPlayback.seek(slot, 0);
      void videoPlayback.play(slot);
    },

    /** 停止有声播放：回到静音循环预览（可见时继续播放）。 */
    stopRound() {
      const target = this.activeRound;
      this.activeRound = null;
      if (!target) return;
      const slot = slotOf('round', target);
      videoPlayback.configure(slot, { muted: true, loop: true });
      videoPlayback.seek(slot, 0);
      if (playbackVisible.has(target) && pageVisible && this.autoplay.round) void videoPlayback.play(slot);
      else videoPlayback.pause(slot);
    },

    setAutoplay(kind: keyof AutoplayPrefs, enabled: boolean) {
      this.autoplay = { ...this.autoplay, [kind]: enabled };
      chatPreferences.writeAutoplay(this.autoplay);
    },
  },
});
