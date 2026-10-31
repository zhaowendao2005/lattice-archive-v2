<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMediaQuery } from '@vueuse/core';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionListContainer from './session-list/SessionListContainer.vue';
import ConversationContainer from './conversation/ConversationContainer.vue';

const chatStore = useChatStore();
const route = useRoute();
const router = useRouter();
const isNarrowWidth = useMediaQuery('(width < 768px)');

// 路由是选中会话的唯一来源；KeepAlive 下离开会话页时返回 null，不做任何处理。
watch(() => (route.name === 'chats' ? String(route.params.chatKey ?? '') : null), (chatKey) => {
  if (chatKey === null) return;
  if (chatKey) {
    void chatStore.openChat(chatKey);
    if (isNarrowWidth.value) chatStore.collapseSessionList();
  } else if (chatStore.activeChatKey) {
    void router.replace({ name: 'chats', params: { chatKey: chatStore.activeChatKey } });
  }
}, { immediate: true });

// 冷启动缓存恢复出上次会话、或切换账户清空选中时，同步回地址栏。
watch(() => chatStore.activeChatKey, (chatKey) => {
  if (route.name !== 'chats' || (chatKey ?? '') === String(route.params.chatKey ?? '')) return;
  void router.replace({ name: 'chats', params: chatKey ? { chatKey } : {} });
});
</script>

<template>
  <main class="relative flex-1 min-w-0 min-h-0 flex overflow-hidden">
    <button
      v-if="isNarrowWidth && !chatStore.isSessionListCollapsed"
      type="button"
      class="absolute inset-0 z-10 bg-black/30"
      aria-label="收起会话列表"
      @click="chatStore.collapseSessionList()"
    />
    <SessionListContainer @keydown.esc="chatStore.collapseSessionList()" />
    <ConversationContainer />
  </main>
</template>
