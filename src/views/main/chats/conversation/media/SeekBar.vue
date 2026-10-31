<script setup lang="ts">
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';

const video = useChatVideoStore();
/** 指针相对进度条的位置（0–1）：几何量当场从事件目标换算，视图不保存元素句柄。 */
const fractionOf = (event: PointerEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
};
const begin = (event: PointerEvent) => {
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  video.startSeek(fractionOf(event));
};
const move = (event: PointerEvent) => {
  video.setHoverPreview(fractionOf(event));
  video.moveSeek(fractionOf(event));
};
</script>

<template>
  <!-- 进度条：底轨 + 已缓冲 + 已播放（主色，末端圆点）；拖动只更新预览，松开才 seek；悬停显示时间 -->
  <div
    v-if="video.viewerVideo"
    role="slider"
    aria-label="播放进度"
    :aria-valuetext="video.viewerVideo.timeLabel"
    :aria-valuenow="Math.round(video.viewerVideo.playedPercent)"
    aria-valuemin="0"
    aria-valuemax="100"
    class="group/seek relative mx-2 h-4 cursor-pointer touch-none"
    @pointerdown.stop="begin"
    @pointermove="move"
    @pointerup="video.endSeek(fractionOf($event))"
    @pointercancel="video.endSeek()"
    @pointerleave="video.setHoverPreview(null)"
  >
    <div class="absolute inset-x-0 top-1/2 h-[5px] -translate-y-1/2 rounded-full bg-media-track transition-[height] group-hover/seek:h-[7px]">
      <span
        v-for="(range, index) in video.viewerVideo.buffered"
        :key="index"
        class="absolute inset-y-0 rounded-full bg-media-buffered"
        :style="{ left: `${range[0]}%`, width: `${range[1]}%` }"
      />
      <span class="absolute inset-y-0 left-0 rounded-full bg-brand" :style="{ width: `${video.viewerVideo.playedPercent}%` }">
        <span :class="['absolute right-0 top-1/2 size-3 -translate-y-1/2 translate-x-1/2 rounded-full bg-brand transition-transform', video.seekPreview !== null ? 'scale-150' : '']" />
      </span>
    </div>
    <span
      v-if="video.hoverLabel"
      class="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-sm bg-media-control px-2 py-0.5 text-xs tabular-nums text-media-foreground"
      :style="{ left: `${((video.seekPreview ?? video.hoverPreview) ?? 0) * 100}%` }"
    >{{ video.hoverLabel }}</span>
  </div>
</template>
