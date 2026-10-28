<script setup lang="ts">
import { ArrowLeftToLine } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import SessionSearch from './SessionSearch.vue';
import SessionItem from './SessionItem.vue';

const chatStore = useChatStore();
</script>

<template>
  <section
    :inert="chatStore.isSessionListCollapsed"
    :aria-hidden="chatStore.isSessionListCollapsed"
    :class="[
      'absolute inset-y-0 left-0 z-20 md:static md:z-auto min-h-0 min-w-0 max-w-full shrink-0 overflow-hidden transition-[width] duration-300 ease-in-out motion-reduce:transition-none',
      chatStore.isSessionListCollapsed ? 'w-0' : 'w-80 shadow-xl md:shadow-none'
    ]"
  >
    <div class="h-full min-h-0 w-80 max-w-full flex flex-col border-r border-border bg-card">
    <div class="shrink-0 px-4 pt-4 pb-3 space-y-3">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            class="size-8 shrink-0 text-muted-foreground"
            aria-label="收起会话列表"
            title="收起会话列表"
            @click="chatStore.toggleSessionList()"
          >
            <ArrowLeftToLine :stroke-width="1.75" />
          </Button>
          <h1 class="truncate text-base font-semibold tracking-tight">会话</h1>
        </div>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ chatStore.filteredSessions.length }}</span>
      </div>
      <SessionSearch />
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-0.5">
      <p v-if="chatStore.filteredSessions.length === 0" class="px-4 py-10 text-center text-sm text-muted-foreground">
        没有匹配的会话
      </p>
      <SessionItem
        v-for="session in chatStore.filteredSessions"
        :key="session.id"
        :session="session"
      />
    </div>
    </div>
  </section>
</template>
