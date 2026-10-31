<script setup lang="ts">
import { Download, Pause, Play, VolumeX } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import type { FeedRound } from '@/stores/chat/types';
import { vMediaVisible } from './mediaVisible';
import { vMediaPlaying, vVideoElement } from './videoElement';
import ProgressRing from './ProgressRing.vue';

const props = defineProps<{ round: FeedRound }>();
const media = useChatMediaStore();
const video = useChatVideoStore();
const SIZE = 240;
const RADIUS = 117;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
</script>

<template>
  <!-- 圆形视频：静音循环预览；点击从头有声播放并显示圆环进度，同一时间只有一个有声播放；不提供 seek -->
  <button
    v-media-visible="props.round.target"
    v-media-playing="props.round.target"
    type="button"
    :aria-label="video.inlineState(props.round.target).active ? '暂停或继续视频消息' : '播放视频消息'"
    class="group relative block shrink-0 overflow-hidden rounded-full bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :style="{ width: `${SIZE}px`, height: `${SIZE}px`, maxWidth: '70vw', maxHeight: '70vw' }"
    @click="video.activateRound(props.round.target)"
  >
    <img v-if="props.round.thumb" :src="props.round.thumb" alt="" aria-hidden="true" draggable="false" class="absolute inset-0 size-full scale-110 object-cover blur-md" />
    <img v-if="media.previewUrl(props.round.previewKey)" :src="media.previewUrl(props.round.previewKey)" alt="" aria-hidden="true" draggable="false" class="absolute inset-0 size-full object-cover" />
    <video
      v-if="video.inlineState(props.round.target).url"
      :key="video.inlineState(props.round.target).url"
      v-video-element="`round:${props.round.target}`"
      :src="video.inlineState(props.round.target).url"
      muted
      loop
      playsinline
      disablepictureinpicture
      class="absolute inset-0 size-full object-cover"
    />

    <svg v-if="video.inlineState(props.round.target).active" viewBox="0 0 240 240" class="pointer-events-none absolute inset-0 size-full -rotate-90 text-brand" aria-hidden="true">
      <circle
        cx="120"
        cy="120"
        :r="RADIUS"
        fill="none"
        stroke="currentColor"
        stroke-width="4"
        stroke-linecap="round"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="CIRCUMFERENCE * (1 - video.inlineState(props.round.target).progress)"
      />
    </svg>

    <span class="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full bg-media-control px-2 py-0.5 text-[11px] font-medium tabular-nums text-media-foreground">
      <VolumeX v-if="!video.inlineState(props.round.target).active" class="size-3" :stroke-width="2" />
      {{ props.round.durationLabel }}
    </span>
    <span
      v-if="!video.inlineState(props.round.target).url || (video.inlineState(props.round.target).active && !video.inlineState(props.round.target).playing)"
      class="absolute left-1/2 top-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-media-control text-media-foreground backdrop-blur-sm"
    >
      <ProgressRing
        v-if="video.inlineState(props.round.target).status === 'loading' || video.inlineState(props.round.target).status === 'queued'"
        :percent="video.inlineState(props.round.target).percent"
        :size="44"
        cancelable
      />
      <Play v-else-if="video.inlineState(props.round.target).active" class="ml-0.5 size-6 fill-current" :stroke-width="1.5" />
      <Download v-else-if="!video.inlineState(props.round.target).url" class="size-5" :stroke-width="1.75" />
      <Pause v-else class="size-6" :stroke-width="1.75" />
    </span>
  </button>
</template>
