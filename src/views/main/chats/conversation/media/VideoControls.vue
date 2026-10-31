<script setup lang="ts">
import { Check, Maximize, Minimize, Pause, PictureInPicture2, Play, RotateCcw, Settings, Volume, Volume1, Volume2, VolumeX } from '@lucide/vue';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import SeekBar from './SeekBar.vue';

const video = useChatVideoStore();
const RATES = [0.5, 1, 1.5, 2];
const BUTTON = 'flex size-8 shrink-0 items-center justify-center rounded-full text-media-foreground outline-none transition-colors hover:bg-media-control focus-visible:ring-2 focus-visible:ring-ring min-h-[var(--hit-target)] min-w-[var(--hit-target)] sm:min-h-8 sm:min-w-8';
const MENU = 'absolute bottom-full right-0 mb-2 min-w-36 overflow-hidden rounded-lg bg-media-surface py-1 text-sm text-media-foreground shadow-xl backdrop-blur-md';
const MENU_ITEM = 'flex w-full items-center justify-between gap-4 px-3 py-1.5 text-left outline-none transition-colors hover:bg-media-control focus-visible:bg-media-control';
</script>

<template>
  <!-- 控制条叠在视频底部：自下而上的渐变；暂停 / 拖动 / 菜单打开时常驻，播放中按显隐规则淡出 -->
  <div
    v-if="video.viewerVideo"
    data-viewer-controls
    :class="[
      'absolute inset-x-0 bottom-0 z-10 bg-linear-to-t from-media-scrim to-transparent px-2 pb-2 pt-8 text-sm transition-opacity duration-300',
      video.controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
    ]"
    @pointerenter="video.setPointerOnControls(true)"
    @pointerleave="video.setPointerOnControls(false)"
    @click.stop
    @dblclick.stop
  >
    <SeekBar />
    <div class="mt-1 flex items-center gap-0.5">
      <button type="button" :class="BUTTON" :aria-label="video.viewerVideo.playback.paused ? '播放' : '暂停'" @click="video.togglePlay()">
        <RotateCcw v-if="video.viewerVideo.playback.ended" class="size-5" :stroke-width="2" />
        <Play v-else-if="video.viewerVideo.playback.paused" class="ml-0.5 size-5 fill-current" :stroke-width="1.5" />
        <Pause v-else class="size-5 fill-current" :stroke-width="1.5" />
      </button>

      <div class="group/volume flex items-center">
        <button type="button" :class="BUTTON" :aria-label="video.player.muted ? '取消静音' : '静音'" @click="video.toggleMute()">
          <VolumeX v-if="video.player.muted || video.player.volume === 0" class="size-5" :stroke-width="1.75" />
          <Volume v-else-if="video.player.volume < 0.3" class="size-5" :stroke-width="1.75" />
          <Volume1 v-else-if="video.player.volume < 0.6" class="size-5" :stroke-width="1.75" />
          <Volume2 v-else class="size-5" :stroke-width="1.75" />
        </button>
        <!-- 音量滑杆：悬停音量键时展开（iOS 不允许脚本调节音量，隐藏） -->
        <div v-if="video.caps.volume" class="w-0 overflow-hidden transition-[width] duration-200 group-hover/volume:w-20 focus-within:w-20">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            aria-label="音量"
            :value="video.player.muted ? 0 : video.player.volume"
            class="mx-2 h-1 w-16 cursor-pointer accent-media-foreground"
            @input="video.setVolume(Number(($event.target as HTMLInputElement).value))"
          />
        </div>
      </div>

      <span class="ml-1 whitespace-nowrap tabular-nums text-media-muted">{{ video.viewerVideo.timeLabel }}</span>
      <span class="flex-1" />

      <div class="relative">
        <button type="button" :class="[BUTTON, 'w-auto px-2 text-xs font-semibold tabular-nums']" aria-label="播放速度" :aria-expanded="video.menu === 'rate'" @click="video.toggleMenu('rate')">
          {{ video.player.rate }}x
        </button>
        <div v-if="video.menu === 'rate'" role="menu" :class="MENU">
          <button
            v-for="rate in RATES"
            :key="rate"
            type="button"
            role="menuitemradio"
            :aria-checked="video.player.rate === rate"
            :class="MENU_ITEM"
            @click="video.setRate(rate)"
          >
            <span class="tabular-nums">{{ rate }}x</span>
            <Check v-if="video.player.rate === rate" class="size-4 text-brand" />
          </button>
        </div>
      </div>

      <div v-if="video.viewerVideo.qualities" class="relative">
        <button type="button" :class="BUTTON" :aria-label="`画质：${video.viewerVideo.qualityLabel}`" :aria-expanded="video.menu === 'quality'" @click="video.toggleMenu('quality')">
          <Settings class="size-5" :stroke-width="1.75" />
        </button>
        <div v-if="video.menu === 'quality'" role="menu" :class="[MENU, 'min-w-48']">
          <p class="px-3 pb-1 pt-0.5 text-xs text-media-muted">画质 · {{ video.viewerVideo.qualityLabel }}</p>
          <button type="button" role="menuitemradio" :aria-checked="!video.selectedQuality[video.viewerVideo.target]" :class="MENU_ITEM" @click="video.setAutoQuality()">
            <span>自动</span>
            <Check v-if="!video.selectedQuality[video.viewerVideo.target]" class="size-4 text-brand" />
          </button>
          <button
            v-for="option in video.viewerVideo.qualities"
            :key="option.id"
            type="button"
            role="menuitemradio"
            :aria-checked="option.active && Boolean(video.selectedQuality[video.viewerVideo.target])"
            :class="MENU_ITEM"
            @click="video.selectQuality(option.id)"
          >
            <span>{{ option.label }} <span class="text-xs text-media-muted tabular-nums">· {{ option.sizeLabel }}</span></span>
            <Check v-if="option.active && video.selectedQuality[video.viewerVideo.target]" class="size-4 text-brand" />
          </button>
        </div>
      </div>

      <button v-if="video.caps.pip" type="button" :class="BUTTON" aria-label="画中画" @click="video.togglePip()">
        <PictureInPicture2 class="size-5" :stroke-width="1.75" />
      </button>
      <button v-if="video.caps.fullscreen" type="button" :class="BUTTON" :aria-label="video.isFullscreen ? '退出全屏' : '全屏'" @click="video.toggleFullscreen()">
        <Minimize v-if="video.isFullscreen" class="size-5" :stroke-width="1.75" />
        <Maximize v-else class="size-5" :stroke-width="1.75" />
      </button>
    </div>
  </div>
</template>
