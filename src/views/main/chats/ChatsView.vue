<script setup lang="ts">
import { onMounted } from 'vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionListContainer from './session-list/SessionListContainer.vue';
import ConversationContainer from './conversation/ConversationContainer.vue';

const chatStore = useChatStore();

onMounted(() => {
  chatStore.initialize();
});
</script>

<template>
  <main class="flex-1 min-w-0 flex overflow-hidden">
    <SessionListContainer />
    <ConversationContainer />
  </main>
</template>
