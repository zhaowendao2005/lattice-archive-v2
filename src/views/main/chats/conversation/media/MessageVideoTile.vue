<script setup lang="ts">
import { EyeOff, Play, RotateCw } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import type { FeedVisual } from '@/stores/chat/types';
import { vMediaVisible } from './mediaVisible';
import ProgressRing from './ProgressRing.vue';

const props = defineProps<{ visual: FeedVisual; aspectRatio: number }>();
const media = useChatMediaStore();
const video = useChatVideoStore();
</script>

<template>
  <!-- 视频缩略图：比例在下载前锁定；模糊 thumb → 封面 / 缩略图；左上角时长与大小，中央播放键；查看器下载中时显示进度 -->
  <button
    v-media-visible="props.visual.target"
    type="button"
    :aria-label="media.tileState(props.visual) === 'spoiler' ? '点击查看隐藏视频' : `播放视频 ${props.visual.durationLabel ?? ''}`"
    class="group relative block w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :style="{ aspectRatio: props.aspectRatio }"
    @click="media.activateVisual(props.visual.target)"
  >
    <img v-if="props.visual.thumb" :src="props.visual.thumb" alt="" aria-hidden="true" draggable="false" class="absolute inset-0 size-full scale-110 object-cover blur-md" />
    <img
      v-if="media.previewUrl(props.visual.previewKey) && media.tileState(props.visual) !== 'spoiler'"
      :src="media.previewUrl(props.visual.previewKey)"
      alt="视频封面"
      decoding="async"
      draggable="false"
      class="absolute inset-0 size-full object-cover animate-in fade-in duration-200"
    />

    <span v-if="media.tileState(props.visual) === 'spoiler'" class="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/40 text-xs font-medium text-foreground backdrop-blur-xl">
      <EyeOff class="size-4" :stroke-width="1.75" />点击查看
    </span>
    <template v-else>
      <span class="absolute left-1.5 top-1.5 rounded-full bg-media-control px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-media-foreground">
        {{ props.visual.durationLabel }}<template v-if="props.visual.sizeLabel"> · {{ props.visual.sizeLabel }}</template>
      </span>
      <span class="absolute left-1/2 top-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-media-control text-media-foreground backdrop-blur-sm transition-transform group-hover:scale-105">
        <ProgressRing
          v-if="video.viewerVideo?.target === props.visual.target && (video.viewerVideo.status === 'loading' || video.viewerVideo.status === 'queued')"
          :percent="video.viewerVideo.percent"
          :size="44"
        />
        <RotateCw v-else-if="media.tileState(props.visual) === 'error'" class="size-5" :stroke-width="1.75" />
        <Play v-else class="ml-0.5 size-6 fill-current" :stroke-width="1.5" />
      </span>
    </template>
  </button>
</template>
