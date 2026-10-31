<script setup lang="ts">
import { ChevronLeft, ChevronRight, RotateCw } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import { vVideoStage } from './videoElement';
import VideoPlayer from './VideoPlayer.vue';

const media = useChatMediaStore();
const video = useChatVideoStore();
const NAV_BUTTON = 'absolute top-1/2 z-20 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full bg-media-control text-media-foreground backdrop-blur-sm transition-opacity hover:opacity-90 outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex';
</script>

<template>
  <!-- 舞台：全屏对象；放大 / 平移 / 触屏滑动翻页的指针手势全部交给 chatMediaStore；点击空白处关闭 -->
  <div
    v-if="media.viewerModel"
    v-video-stage
    :class="['relative flex min-h-0 flex-1 items-center justify-center overflow-hidden', video.isFullscreen ? 'bg-media-backdrop' : 'px-3 pb-2 sm:px-16']"
    @wheel="media.handleWheel($event)"
    @pointerdown="media.stagePointerDown($event)"
    @pointermove="media.stagePointerMove($event)"
    @pointerup="media.stagePointerUp($event)"
    @pointercancel="media.stagePointerUp($event)"
    @click.self="media.handleBackdropClick()"
  >
    <div
      :class="['flex size-full items-center justify-center', media.zoom.scale > 1 ? 'cursor-grab active:cursor-grabbing' : 'transition-transform duration-150']"
      :style="media.zoomStyle"
      @click.self="media.handleBackdropClick()"
    >
      <img
        v-if="media.viewerModel.type === 'photo' && media.viewerModel.src"
        :src="media.viewerModel.src"
        alt="图片"
        draggable="false"
        :class="['max-h-full max-w-full object-contain transition-[filter] duration-200', media.viewerModel.quality === 'thumb' ? 'blur-lg' : '']"
        :style="{ width: `${media.viewerModel.width}px`, aspectRatio: media.viewerModel.width / Math.max(1, media.viewerModel.height) }"
        @dblclick="media.zoom.scale > 1 ? media.resetZoom() : media.zoomIn()"
      />
      <VideoPlayer v-else-if="media.viewerModel.type !== 'photo'" />
    </div>

    <p v-if="media.viewerModel.error" class="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-media-surface px-3 py-1.5 text-xs text-destructive shadow-sm">
      {{ media.viewerModel.error }}
      <button type="button" class="inline-flex items-center gap-1 text-media-foreground hover:text-brand" @click="media.loadViewerAssets()">
        <RotateCw class="size-3.5" />重试
      </button>
    </p>

    <template v-if="!video.isFullscreen && media.zoom.scale === 1">
      <button
        v-if="media.viewerModel.hasPrev"
        type="button"
        :class="[NAV_BUTTON, 'left-3', video.controlsVisible || media.viewerModel.type === 'photo' ? 'opacity-100' : 'pointer-events-none opacity-0']"
        aria-label="上一个"
        @click="media.stepViewer(-1)"
      >
        <ChevronLeft class="size-6" :stroke-width="1.75" />
      </button>
      <button
        v-if="media.viewerModel.hasNext"
        type="button"
        :class="[NAV_BUTTON, 'right-3', video.controlsVisible || media.viewerModel.type === 'photo' ? 'opacity-100' : 'pointer-events-none opacity-0']"
        aria-label="下一个"
        @click="media.stepViewer(1)"
      >
        <ChevronRight class="size-6" :stroke-width="1.75" />
      </button>
    </template>
  </div>
</template>
