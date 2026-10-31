<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { messageViewport } from '@/stores/chat/data-sources/messageViewport';
import MessageBubble from './MessageBubble.vue';
import FeedStatus from './FeedStatus.vue';

const chatStore = useChatStore();

/** 滚动容器句柄交给 Data Source 单例，视图不持有 ref。 */
function attachViewport(target: Element | ComponentPublicInstance | null) {
  messageViewport.attach(target instanceof Element ? target : null);
}

const OLDER_LABELS = { loading: '正在加载更早的消息…', end: '已显示最早的消息', idle: '' } as const;
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <!-- 低对比度结构背景固定在视口层，不随长历史一起滚走 -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-cover bg-center opacity-25"
      style="background-image: url('/backgrounds/isometric-structure.png');"
    />

    <!-- 关闭浏览器原生滚动锚定，统一由 messageViewport 做顶部插入补偿，避免双重修正 -->
    <div
      :ref="attachViewport"
      class="relative h-full overflow-y-auto px-5 pb-4 [overflow-anchor:none]"
      @scroll.passive="chatStore.handleFeedScroll()"
    >
      <div class="mx-auto max-w-3xl">
        <!-- 固定高度的历史加载提示位：显隐不改变布局高度，顶部插入补偿才准确 -->
        <p class="h-9 flex items-center justify-center text-xs text-muted-foreground">{{ OLDER_LABELS[chatStore.olderState] }}</p>

        <FeedStatus v-if="chatStore.feedState !== 'ready'" />
        <div v-else class="space-y-1.5">
          <template v-for="item in chatStore.feedItems" :key="item.key">
            <p v-if="item.type === 'day'" class="pt-3 pb-1 text-center text-xs text-muted-foreground">{{ item.label }}</p>
            <p v-else-if="item.type === 'service'" class="flex justify-center py-1">
              <span class="max-w-[85%] rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">{{ item.text }}</span>
            </p>
            <MessageBubble v-else :item="item" />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
