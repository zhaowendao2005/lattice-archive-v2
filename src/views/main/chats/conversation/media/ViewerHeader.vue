<script setup lang="ts">
import { DialogClose, DialogDescription, DialogTitle } from 'reka-ui';
import { Download, Loader2, X, ZoomIn, ZoomOut } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import ProgressRing from './ProgressRing.vue';

const media = useChatMediaStore();
const video = useChatVideoStore();
const ICON_BUTTON = 'flex size-10 items-center justify-center rounded-full text-media-foreground outline-none transition-colors hover:bg-media-control focus-visible:ring-2 focus-visible:ring-ring';
</script>

<template>
  <!-- 页眉：头像缩写 + 发送者 / 会话名 + 「序号 · 日期」；右侧放大 / 缩小、下载（视频带进度，可取消）、关闭 -->
  <header v-if="media.viewerModel" class="flex items-center gap-3 px-4 py-2.5">
    <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-media-control text-sm font-semibold text-media-foreground">{{ media.viewerModel.initials }}</span>
    <div class="min-w-0 flex-1">
      <DialogTitle class="truncate text-sm font-medium text-media-foreground">{{ media.viewerModel.title }}</DialogTitle>
      <DialogDescription class="truncate text-xs tabular-nums text-media-muted">{{ media.viewerModel.position }} · {{ media.viewerModel.dateLabel }}</DialogDescription>
    </div>
    <Loader2 v-if="media.viewerModel.type === 'photo' && media.viewerModel.isLoading" class="size-4 animate-spin text-media-muted" aria-label="原图加载中" />
    <button v-if="media.zoom.scale > 1" type="button" :class="ICON_BUTTON" aria-label="缩小" @click="media.zoomOut()">
      <ZoomOut class="size-5" :stroke-width="1.75" />
    </button>
    <button type="button" :class="ICON_BUTTON" aria-label="放大" @click="media.zoomIn()">
      <ZoomIn class="size-5" :stroke-width="1.75" />
    </button>
    <button
      v-if="media.viewerModel.type === 'photo' ? media.viewerModel.quality === 'full' : video.viewerVideo && video.viewerVideo.status !== 'too-large'"
      type="button"
      :class="ICON_BUTTON"
      :aria-label="video.viewerVideo?.saving ? '取消保存' : '保存'"
      @click="media.saveViewerMedia()"
    >
      <ProgressRing v-if="media.viewerModel.type !== 'photo' && video.viewerVideo?.saving" :percent="video.viewerVideo.percent" :size="28" cancelable />
      <Download v-else class="size-5" :stroke-width="1.75" />
    </button>
    <DialogClose :class="ICON_BUTTON" aria-label="关闭">
      <X class="size-5" :stroke-width="1.75" />
    </DialogClose>
  </header>
</template>
