<script setup lang="ts">
import { Download, EyeOff, Loader2, RotateCw } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import type { FeedPhoto } from '@/stores/chat/types';
import { vMediaVisible } from './mediaVisible';

const props = defineProps<{ photo: FeedPhoto; aspectRatio: number }>();
const media = useChatMediaStore();

const LABELS = { spoiler: '点击查看隐藏图片', manual: '点击加载图片', error: '图片加载失败，点击重试', ready: '查看大图', loading: '图片加载中', idle: '图片' } as const;
</script>

<template>
  <!-- 比例在下载前即锁定：模糊缩略图 → 预览图逐级覆盖，加载过程不改变气泡高度 -->
  <button
    v-media-visible="props.photo.target"
    type="button"
    :data-photo-state="media.tileState(props.photo)"
    :aria-label="LABELS[media.tileState(props.photo)]"
    :title="media.tileState(props.photo) === 'error' ? media.entries[props.photo.previewKey]?.error : undefined"
    class="group relative block w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
    :style="{ aspectRatio: props.aspectRatio }"
    @click="media.activateVisual(props.photo.target)"
  >
    <img
      v-if="props.photo.thumb"
      :src="props.photo.thumb"
      alt=""
      aria-hidden="true"
      draggable="false"
      class="absolute inset-0 size-full scale-110 object-cover blur-md"
    />
    <img
      v-if="media.entries[props.photo.previewKey]?.url && media.tileState(props.photo) !== 'spoiler'"
      :src="media.entries[props.photo.previewKey]?.url"
      alt="图片"
      decoding="async"
      draggable="false"
      class="absolute inset-0 size-full object-cover animate-in fade-in duration-200"
    />

    <span v-if="media.tileState(props.photo) === 'spoiler'" class="absolute inset-0 flex items-center justify-center gap-1.5 bg-background/40 text-xs font-medium text-foreground backdrop-blur-xl">
      <EyeOff class="size-4" :stroke-width="1.75" />点击查看
    </span>
    <span
      v-else-if="media.tileState(props.photo) !== 'ready' && media.tileState(props.photo) !== 'idle'"
      class="absolute left-1/2 top-1/2 flex size-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 text-foreground backdrop-blur-sm"
    >
      <Loader2 v-if="media.tileState(props.photo) === 'loading'" class="size-5 animate-spin" :stroke-width="1.75" />
      <RotateCw v-else-if="media.tileState(props.photo) === 'error'" class="size-5 text-destructive" :stroke-width="1.75" />
      <Download v-else class="size-5" :stroke-width="1.75" />
    </span>
  </button>
</template>
