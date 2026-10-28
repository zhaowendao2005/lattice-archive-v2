<script setup lang="ts">
import { onMounted } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionListContainer from './session-list/SessionListContainer.vue';
import ConversationContainer from './conversation/ConversationContainer.vue';

const chatStore = useChatStore();
const isNarrowWidth = useMediaQuery('(width < 768px)');

onMounted(() => {
  chatStore.initialize();
});
</script>

<template>
  <main class="relative flex-1 min-w-0 min-h-0 flex overflow-hidden">
    <button
      v-if="isNarrowWidth && !chatStore.isSessionListCollapsed"
      type="button"
      class="absolute inset-0 z-10 bg-black/30"
      aria-label="收起会话列表"
      @click="chatStore.isSessionListCollapsed = true"
    />
    <SessionListContainer @keydown.esc="chatStore.isSessionListCollapsed = true" />
    <ConversationContainer />
  </main>
</template>
