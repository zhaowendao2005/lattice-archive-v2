<script setup lang="ts">
import { FileVideo, Play } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import type { FeedVideoFile } from '@/stores/chat/types';
import { vMediaVisible } from './mediaVisible';

/** out：我方气泡（主色底）需要反色的次要文字。 */
const props = defineProps<{ file: FeedVideoFile; out: boolean }>();
const media = useChatMediaStore();
</script>

<template>
  <!-- 以文件方式发送的视频：附件卡片，点击进入播放器（单独打开，不参与查看器翻页） -->
  <button
    v-media-visible="props.file.target"
    type="button"
    :aria-label="`播放视频文件 ${props.file.fileName}`"
    :class="['mb-1 flex w-full min-w-56 max-w-full items-center gap-3 rounded-lg p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', props.out ? 'bg-primary-foreground/15 hover:bg-primary-foreground/20' : 'bg-card hover:bg-accent']"
    @click="media.openViewer(props.file.target, true)"
  >
    <span class="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
      <img v-if="props.file.thumb" :src="props.file.thumb" alt="" aria-hidden="true" class="absolute inset-0 size-full scale-110 object-cover blur-sm" />
      <img v-if="media.previewUrl(props.file.previewKey)" :src="media.previewUrl(props.file.previewKey)" alt="" aria-hidden="true" class="absolute inset-0 size-full object-cover" />
      <span class="relative flex size-7 items-center justify-center rounded-full bg-media-control text-media-foreground">
        <Play v-if="props.file.playable" class="ml-0.5 size-3.5 fill-current" :stroke-width="1.5" />
        <FileVideo v-else class="size-3.5" :stroke-width="1.75" />
      </span>
    </span>
    <span class="min-w-0 flex-1">
      <span class="block truncate text-sm font-medium">{{ props.file.fileName }}</span>
      <span :class="['block text-xs tabular-nums', props.out ? 'text-primary-foreground/75' : 'text-muted-foreground']">{{ props.file.metaLabel }}</span>
    </span>
  </button>
</template>
