<script setup lang="ts">
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { ChatSessionMock } from '@/stores/chat/mocks/chatMock';

const props = defineProps<{
  session: ChatSessionMock;
}>();

const chatStore = useChatStore();
</script>

<template>
  <button
    type="button"
    :class="[
      'w-full flex gap-3 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
      chatStore.activeSessionId === props.session.id ? 'bg-accent' : 'hover:bg-accent/50'
    ]"
    @click="chatStore.selectSession(props.session.id)"
  >
    <span class="size-10 shrink-0 rounded-full bg-brand-soft text-brand text-xs font-semibold flex items-center justify-center">
      {{ props.session.avatarText }}
    </span>

    <span class="flex-1 min-w-0">
      <span class="flex items-baseline justify-between gap-2">
        <span class="text-sm font-medium truncate">{{ props.session.title }}</span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ props.session.timestamp }}</span>
      </span>
      <span class="mt-0.5 flex items-center gap-2">
        <span class="flex-1 text-[13px] text-muted-foreground truncate">{{ props.session.lastMessage }}</span>
        <span
          v-if="props.session.unreadCount > 0"
          class="shrink-0 min-w-5 h-5 px-1.5 rounded-full bg-brand text-brand-foreground text-[11px] font-semibold tabular-nums flex items-center justify-center"
        >
          {{ props.session.unreadCount }}
        </span>
      </span>
      <span class="mt-1 block text-[11px] text-muted-foreground truncate">{{ props.session.tags.join('  ') }}</span>
    </span>
  </button>
</template>
