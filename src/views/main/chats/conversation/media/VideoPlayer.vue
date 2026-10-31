<script setup lang="ts">
import { AlertTriangle, Download, FileWarning, Loader2, Play, RotateCcw, RotateCw } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import { vVideoElement } from './videoElement';
import ProgressRing from './ProgressRing.vue';
import VideoControls from './VideoControls.vue';

const media = useChatMediaStore();
const video = useChatVideoStore();
/** 舞台高度扣除页眉与说明区（参考实现 max-height: calc(100vh - 8.25rem)）；全屏时铺满。 */
const boxStyle = (width: number, height: number, fullscreen: boolean) => {
  const ratio = width / Math.max(1, height);
  const maxHeight = fullscreen ? '100dvh' : 'calc(100dvh - 9.5rem)';
  return { aspectRatio: String(ratio), width: `min(100%, calc(${maxHeight} * ${ratio}))`, maxHeight };
};
const CARD = 'absolute left-1/2 top-1/2 flex w-72 max-w-[85%] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 rounded-xl bg-media-surface px-5 py-4 text-center text-sm text-media-foreground shadow-xl backdrop-blur-md';
const CARD_ACTION = 'inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-medium text-brand-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-ring';
</script>

<template>
  <!-- 播放器盒子按视频比例锁定尺寸；控制条叠在盒子内部，宽度等于视频实际显示宽度 -->
  <div
    v-if="media.viewerModel && video.viewerVideo"
    :class="['relative overflow-hidden', !video.controlsVisible && video.isPlayingViewer() ? 'cursor-none' : '']"
    :style="boxStyle(media.viewerModel.width, media.viewerModel.height, video.isFullscreen)"
    @pointermove="video.pokeControls()"
    @pointerleave="video.pointerLeftStage()"
  >
    <img
      v-if="media.viewerModel.posterUrl && !video.viewerVideo.playback.attached"
      :src="media.viewerModel.posterUrl"
      alt=""
      aria-hidden="true"
      draggable="false"
      :class="['absolute inset-0 size-full object-contain', media.viewerModel.posterUrl === media.viewerModel.thumb ? 'blur-lg' : '']"
    />
    <video
      v-if="video.viewerVideo.url && video.viewerVideo.status !== 'unsupported'"
      :key="video.viewerVideo.url"
      v-video-element="'viewer'"
      :src="video.viewerVideo.url"
      :poster="media.viewerModel.posterUrl"
      playsinline
      controlslist="nodownload"
      class="absolute inset-0 size-full object-contain"
      @click="video.handleVideoClick()"
      @dblclick="video.handleVideoDoubleClick()"
    />

    <!-- 中央层：下载进度 / 大小确认 / 不支持 / 失败 / 暂停或拦截时的大播放键 / 卡顿加载圈 -->
    <template v-if="video.viewerVideo.status === 'loading' || video.viewerVideo.status === 'queued'">
      <span class="absolute left-2 top-2 rounded-full bg-media-control px-2 py-0.5 text-xs tabular-nums text-media-foreground">
        下载中 {{ video.viewerVideo.percent }}% · {{ video.viewerVideo.progressLabel }}
      </span>
      <button
        type="button"
        class="absolute left-1/2 top-1/2 flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-media-control text-media-foreground outline-none backdrop-blur-sm focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="取消下载"
        @click.stop="video.cancelViewerDownload()"
      >
        <ProgressRing :percent="video.viewerVideo.percent" :size="56" cancelable />
      </button>
    </template>
    <div v-else-if="video.viewerVideo.status === 'confirm'" :class="CARD">
      <Download class="size-6" :stroke-width="1.75" />
      <p>文件较大（{{ video.viewerVideo.sizeLabel }}），需要完整下载后才能播放。</p>
      <button type="button" :class="CARD_ACTION" @click.stop="video.confirmLarge()">下载并播放</button>
    </div>
    <div v-else-if="video.viewerVideo.status === 'too-large'" :class="CARD">
      <FileWarning class="size-6" :stroke-width="1.75" />
      <p>文件过大（{{ video.viewerVideo.sizeLabel }}），暂不支持在应用内播放；后续版本将支持边下边播。</p>
    </div>
    <div v-else-if="video.viewerVideo.status === 'unsupported'" :class="CARD">
      <FileWarning class="size-6" :stroke-width="1.75" />
      <p>当前浏览器无法播放此视频格式，可以保存到本地后用其他播放器打开。</p>
      <button type="button" :class="CARD_ACTION" @click.stop="video.saveViewerVideo()">
        <Download class="size-3.5" />{{ video.viewerVideo.saving ? `保存中 ${video.viewerVideo.percent}%` : '保存文件' }}
      </button>
    </div>
    <div v-else-if="video.viewerVideo.status === 'error'" :class="CARD">
      <AlertTriangle class="size-6 text-destructive" :stroke-width="1.75" />
      <p>{{ video.viewerVideo.error || '视频加载失败' }}</p>
      <button type="button" :class="CARD_ACTION" @click.stop="video.retryViewer()"><RotateCw class="size-3.5" />重试</button>
    </div>
    <button
      v-else-if="video.viewerVideo.status === 'idle'"
      type="button"
      class="absolute left-1/2 top-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-media-control text-media-foreground outline-none backdrop-blur-sm focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="下载并播放"
      @click.stop="video.retryViewer()"
    >
      <Play class="ml-1 size-7 fill-current" :stroke-width="1.5" />
    </button>
    <template v-else-if="video.viewerVideo.status === 'ready' && video.viewerVideo.playback.attached">
      <Loader2
        v-if="video.viewerVideo.playback.waiting && !video.viewerVideo.playback.paused"
        class="pointer-events-none absolute left-1/2 top-1/2 size-10 -translate-x-1/2 -translate-y-1/2 animate-spin text-media-foreground opacity-0 [animation-delay:300ms] [animation-fill-mode:forwards] animate-in fade-in"
        aria-label="缓冲中"
      />
      <button
        v-else-if="video.viewerVideo.kind !== 'gif' && (video.viewerVideo.playback.paused || video.viewerVideo.playback.blocked)"
        type="button"
        class="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2 text-media-foreground outline-none"
        :aria-label="video.viewerVideo.playback.ended ? '重新播放' : '播放'"
        @click.stop="video.togglePlay()"
      >
        <span class="flex size-14 items-center justify-center rounded-full bg-media-control backdrop-blur-sm transition-transform hover:scale-105">
          <RotateCcw v-if="video.viewerVideo.playback.ended" class="size-6" :stroke-width="2" />
          <Play v-else class="ml-1 size-7 fill-current" :stroke-width="1.5" />
        </span>
        <span v-if="video.viewerVideo.playback.blocked" class="rounded-full bg-media-control px-2 py-0.5 text-xs">点击播放</span>
      </button>
    </template>

    <VideoControls v-if="video.viewerVideo.status === 'ready' && video.viewerVideo.kind !== 'gif' && video.viewerVideo.playback.attached" />
  </div>
</template>
