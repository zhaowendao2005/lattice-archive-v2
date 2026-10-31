<script setup lang="ts">
import { BellOff, Pin } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { SessionListItem } from '@/stores/chat/types';

const props = defineProps<{ item: SessionListItem }>();
const chatStore = useChatStore();
</script>

<template>
  <RouterLink
    :to="{ name: 'chats', params: { chatKey: props.item.key } }"
    :class="[
      'flex w-full gap-3 rounded-lg px-3 py-2.5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
      chatStore.activeChatKey === props.item.key ? 'bg-accent' : 'hover:bg-accent/50'
    ]"
    :aria-current="chatStore.activeChatKey === props.item.key ? 'page' : undefined"
  >
    <span class="size-10 shrink-0 rounded-full bg-brand-soft text-brand text-xs font-semibold flex items-center justify-center">
      {{ props.item.initials }}
    </span>

    <span class="flex-1 min-w-0">
      <span class="flex items-baseline justify-between gap-2">
        <span class="flex min-w-0 items-center gap-1">
          <span class="truncate text-sm font-medium">{{ props.item.title }}</span>
          <BellOff v-if="props.item.muted" class="size-3.5 shrink-0 text-muted-foreground" :stroke-width="1.75" aria-label="已静音" />
        </span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ props.item.timeLabel }}</span>
      </span>
      <span class="mt-0.5 flex items-center gap-2">
        <span class="flex-1 truncate text-[13px] text-muted-foreground">{{ props.item.preview }}</span>
        <span
          v-if="props.item.unreadCount > 0 || props.item.unreadMark"
          :class="[
            'shrink-0 min-w-5 h-5 px-1.5 rounded-full text-[11px] font-semibold tabular-nums flex items-center justify-center',
            props.item.muted ? 'bg-muted text-muted-foreground' : 'bg-brand text-brand-foreground'
          ]"
        >
          {{ props.item.unreadCount > 99 ? '99+' : props.item.unreadCount || '' }}
        </span>
        <Pin v-else-if="props.item.pinned" class="size-3.5 shrink-0 rotate-45 text-muted-foreground" :stroke-width="1.75" aria-label="已置顶" />
      </span>
    </span>
  </RouterLink>
</template>
