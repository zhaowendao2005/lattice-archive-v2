<script setup lang="ts">
import { MessagesSquare } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import ConversationHeader from './ConversationHeader.vue';
import MessageFeed from './MessageFeed.vue';
import ReadOnlyNotice from './ReadOnlyNotice.vue';
import MediaViewer from './media/MediaViewer.vue';

const chatStore = useChatStore();
</script>

<template>
  <section class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
    <ConversationHeader />
    <template v-if="chatStore.activeChatKey">
      <MessageFeed />
      <ReadOnlyNotice />
      <MediaViewer />
    </template>
    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <MessagesSquare class="size-8" :stroke-width="1.5" />
      <p class="text-sm">从左侧选择一个会话开始浏览</p>
    </div>
  </section>
</template>
