<!--
  ============================================================================
  会话页（/workspace/chats/:chatKey?）
  ============================================================================
  这是一个「路由 ↔ Store 双向同步」的适配层：
  · 路由是选中会话的唯一事实来源：URL 变了 → 通知 Store 打开；
  · 反之，Store 恢复出上次会话（冷启动缓存 / 切换账户）→ 回写地址栏；
  · 两者用“值相等就 return”防止互相触发形成循环。
  窄屏（<768px）上会话列表是抽屉，选中后自动收起。
-->
<script setup lang="ts">
import { watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useMediaQuery } from '@vueuse/core';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionListContainer from './session-list/SessionListContainer.vue';
import ConversationContainer from './conversation/ConversationContainer.vue';
import BotHarvestCandidateModal from './conversation/BotHarvestCandidateModal.vue';
import BotHarvestDialog from './conversation/BotHarvestDialog.vue';

const chatStore = useChatStore();
const route = useRoute();
const router = useRouter();
const isNarrowWidth = useMediaQuery('(width < 768px)');

// 方向一：URL → Store。chatKey 为空时不处理（含 KeepAlive 离场返回 null 的情况）
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
// 方向二：Store → URL。例如缓存恢复出上次会话、或切号后选中被清空
watch(() => chatStore.activeChatKey, (chatKey) => {
  if (route.name !== 'chats' || (chatKey ?? '') === String(route.params.chatKey ?? '')) return;
  void router.replace({ name: 'chats', params: chatKey ? { chatKey } : {} });
});
</script>

<template>
  <!-- 左右分栏：左会话列表（可折叠成抽屉），右内容区 -->
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
    <BotHarvestDialog />
    <BotHarvestCandidateModal />
  </main>
</template>
