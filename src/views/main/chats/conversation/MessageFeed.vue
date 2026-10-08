<script setup lang="ts">
import { useChatStore } from '@/stores/chat/stores/chatStore';
import MessageBubble from './MessageBubble.vue';

const chatStore = useChatStore();
</script>

<template>
  <div class="relative min-h-0 flex-1 overflow-y-auto px-5 py-5">
    <!-- 低对比度结构背景：保留几何层次，但不干扰消息阅读 -->
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-cover bg-center opacity-35"
      style="background-image: url('/backgrounds/isometric-structure.png');"
    />

    <div class="relative mx-auto max-w-3xl space-y-4">
      <p v-if="chatStore.activeMessages.length === 0" class="py-16 text-center text-sm text-muted-foreground">
        这个会话还没有消息
      </p>
      <p v-else class="text-center text-xs text-muted-foreground">今天</p>

      <MessageBubble
        v-for="msg in chatStore.activeMessages"
        :key="msg.id"
        :message="msg"
      />
    </div>
  </div>
</template>
