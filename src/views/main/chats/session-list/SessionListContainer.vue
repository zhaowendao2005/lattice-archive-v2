<script setup lang="ts">
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionSearch from './SessionSearch.vue';
import SessionItem from './SessionItem.vue';

const chatStore = useChatStore();
</script>

<template>
  <section class="w-80 min-w-[280px] max-w-[340px] min-h-0 shrink-0 flex flex-col border-r border-border">
    <div class="shrink-0 px-4 pt-4 pb-3 space-y-3">
      <div class="flex items-baseline justify-between">
        <h1 class="text-base font-semibold tracking-tight">会话</h1>
        <span class="text-xs text-muted-foreground tabular-nums">{{ chatStore.filteredSessions.length }}</span>
      </div>
      <SessionSearch />
    </div>

    <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
      <p v-if="chatStore.filteredSessions.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        没有匹配的会话
      </p>
      <SessionItem
        v-for="session in chatStore.filteredSessions"
        :key="session.id"
        :session="session"
      />
    </div>
  </section>
</template>
