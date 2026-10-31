<script setup lang="ts">
import { Play } from '@lucide/vue';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';

const media = useChatMediaStore();
</script>

<template>
  <!-- 相册胶片条：仅当前项属于相册时显示；当前项高亮，点击跳转 -->
  <nav v-if="media.viewerModel?.filmstrip" class="flex justify-center gap-1.5 overflow-x-auto px-4 pb-3" aria-label="相册">
    <button
      v-for="item in media.viewerModel.filmstrip"
      :key="item.target"
      type="button"
      :aria-current="item.active ? 'true' : undefined"
      :aria-label="item.isVideo ? '相册中的视频' : '相册中的图片'"
      :class="[
        'relative h-16 w-12 shrink-0 overflow-hidden rounded-md bg-media-control outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-ring',
        item.active ? 'opacity-100 ring-2 ring-brand' : 'opacity-50 hover:opacity-80'
      ]"
      @click="media.jumpViewer(item.target)"
    >
      <img v-if="item.url || item.thumb" :src="item.url ?? item.thumb" alt="" aria-hidden="true" draggable="false" :class="['size-full object-cover', item.url ? '' : 'blur-sm']" />
      <Play v-if="item.isVideo" class="absolute left-1/2 top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 fill-current text-media-foreground" :stroke-width="1.5" />
    </button>
  </nav>
</template>
