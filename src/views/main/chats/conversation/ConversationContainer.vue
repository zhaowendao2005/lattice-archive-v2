<script setup lang="ts">
import ConversationHeader from './ConversationHeader.vue';
import MessageFeed from './MessageFeed.vue';
import MessageInput from './MessageInput.vue';
</script>

<template>
  <section class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
    <ConversationHeader />
    <MessageFeed />
    <MessageInput />
  </section>
</template>
