<script setup lang="ts">
import { Download, EyeOff } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import type { FeedVisual } from '@/stores/chat/types';
import { vMediaVisible } from './mediaVisible';
import { vMediaPlaying, vVideoElement } from './videoElement';
import ProgressRing from './ProgressRing.vue';

const props = defineProps<{ visual: FeedVisual; aspectRatio: number }>();
const media = useChatMediaStore();
const video = useChatVideoStore();
</script>

<template>
  <!-- GIF：满足自动播放条件时静音循环；仅在 ≥ 50% 可见且页面在前台时播放；否则显示缩略图，点击手动加载 -->
  <button
    v-media-visible="props.visual.target"
    v-media-playing="props.visual.target"
    type="button"
    :aria-label="video.inlineState(props.visual.target).url ? '查看 GIF' : '加载 GIF'"
    class="group relative block w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :style="{ aspectRatio: props.aspectRatio }"
    @click="video.activateGif(props.visual.target)"
  >
    <img v-if="props.visual.thumb" :src="props.visual.thumb" alt="" aria-hidden="true" draggable="false" class="absolute inset-0 size-full scale-110 object-cover blur-md" />
    <img
      v-if="media.previewUrl(props.visual.previewKey)"
      :src="media.previewUrl(props.visual.previewKey)"
      alt=""
      aria-hidden="true"
      draggable="false"
      class="absolute inset-0 size-full object-cover"
    />
    <video
      v-if="video.inlineState(props.visual.target).url && media.tileState(props.visual) !== 'spoiler'"
      :key="video.inlineState(props.visual.target).url"
      v-video-element="`gif:${props.visual.target}`"
      :src="video.inlineState(props.visual.target).url"
      muted
      loop
      playsinline
      disablepictureinpicture
      class="absolute inset-0 size-full object-cover"
    />

    <span v-if="media.tileState(props.visual) === 'spoiler'" class="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/40 text-xs font-medium text-foreground backdrop-blur-xl">
      <EyeOff class="size-4" :stroke-width="1.75" />点击查看
    </span>
    <template v-else>
      <span class="absolute left-1.5 top-1.5 rounded-full bg-media-control px-1.5 py-0.5 text-[11px] font-semibold text-media-foreground">GIF</span>
      <span
        v-if="!video.inlineState(props.visual.target).url"
        class="absolute left-1/2 top-1/2 flex size-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-media-control text-media-foreground backdrop-blur-sm"
      >
        <ProgressRing
          v-if="video.inlineState(props.visual.target).status === 'loading' || video.inlineState(props.visual.target).status === 'queued'"
          :percent="video.inlineState(props.visual.target).percent"
          :size="40"
          cancelable
        />
        <Download v-else class="size-5" :stroke-width="1.75" />
      </span>
    </template>
  </button>
</template>
