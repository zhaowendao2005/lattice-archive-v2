<script setup lang="ts">
import { onMounted } from 'vue';
import { Clapperboard, ImageDown, Trash2 } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { useChatVideoStore } from '@/stores/chat/stores/chatVideoStore';
import type { AutoDownloadPrefs, AutoplayPrefs } from '@/stores/chat/types';

const media = useChatMediaStore();
const video = useChatVideoStore();
const OPTIONS: { key: keyof AutoDownloadPrefs; label: string; hint: string }[] = [
  { key: 'private', label: '私聊', hint: '与个人、机器人及收藏夹的会话' },
  { key: 'group', label: '群组', hint: '普通群组与超级群组' },
  { key: 'channel', label: '频道', hint: '广播频道' },
];
const AUTOPLAY_OPTIONS: { key: keyof AutoplayPrefs; label: string; hint: string }[] = [
  { key: 'gif', label: '自动播放 GIF', hint: '静音循环，仅在可见时播放；10 MB 以内自动下载' },
  { key: 'round', label: '自动播放视频消息', hint: '圆形视频静音预览，点击后有声播放；10 MB 以内自动下载' },
];
const SWITCH = 'relative h-6 w-10 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40';
const KNOB = 'absolute left-0.5 top-0.5 size-5 rounded-full bg-card shadow-sm transition-transform duration-150';

onMounted(() => { void media.refreshCacheUsage(); });
</script>

<template>
  <section class="space-y-3">
    <span class="text-sm font-medium">媒体自动下载与播放</span>
    <div class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
      <p class="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground">
        <ImageDown class="mt-0.5 size-4 shrink-0" :stroke-width="1.75" />
        图片与视频封面滚动到可见范围时才下载预览，原图只在打开查看器时下载。关闭后仍显示模糊缩略图，点击即可手动加载。
      </p>
      <div v-for="option in OPTIONS" :key="option.key" class="flex items-center justify-between gap-6 px-4 py-3.5">
        <div>
          <div class="text-sm font-medium">{{ option.label }}</div>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ option.hint }}</p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-label="`${option.label}自动下载媒体`"
          :aria-checked="media.autoDownload[option.key]"
          :class="[SWITCH, media.autoDownload[option.key] ? 'bg-brand' : 'bg-input']"
          @click="media.setAutoDownload(option.key, !media.autoDownload[option.key])"
        >
          <span :class="[KNOB, media.autoDownload[option.key] ? 'translate-x-4' : 'translate-x-0']" />
        </button>
      </div>
      <p class="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground">
        <Clapperboard class="mt-0.5 size-4 shrink-0" :stroke-width="1.75" />
        普通视频需点击后下载：100 MB 以内直接播放，100–300 MB 需确认，自动选择不超过 720p 的画质以缩短等待。
      </p>
      <div v-for="option in AUTOPLAY_OPTIONS" :key="option.key" class="flex items-center justify-between gap-6 px-4 py-3.5">
        <div>
          <div class="text-sm font-medium">{{ option.label }}</div>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ option.hint }}</p>
        </div>
        <button
          type="button"
          role="switch"
          :aria-label="option.label"
          :aria-checked="video.autoplay[option.key]"
          :class="[SWITCH, video.autoplay[option.key] ? 'bg-brand' : 'bg-input']"
          @click="video.setAutoplay(option.key, !video.autoplay[option.key])"
        >
          <span :class="[KNOB, video.autoplay[option.key] ? 'translate-x-4' : 'translate-x-0']" />
        </button>
      </div>
      <div class="flex items-center justify-between gap-6 px-4 py-3.5">
        <div>
          <div class="text-sm font-medium">本机媒体缓存</div>
          <p class="mt-0.5 text-xs text-muted-foreground tabular-nums">{{ media.cacheUsageLabel }} · 加密保存在本设备，5 天后自动清理；完整视频只保留在内存中</p>
        </div>
        <button
          type="button"
          class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          @click="media.clearMediaCache()"
        >
          <Trash2 class="size-3.5" :stroke-width="1.75" />{{ media.isClearingCache ? '清理中…' : '清除' }}
        </button>
      </div>
    </div>
  </section>
</template>
