<script setup lang="ts">
import { Archive, Ellipsis } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <header class="h-14 shrink-0 flex items-center justify-between gap-3 px-5 border-b border-border">
    <div class="min-w-0">
      <h2 class="text-sm font-semibold truncate">{{ chatStore.activeSession?.title ?? '未选择会话' }}</h2>
      <p class="text-xs text-muted-foreground truncate">{{ chatStore.activeSession?.tags.join('  ') }}</p>
    </div>

    <div class="shrink-0 flex items-center gap-1">
      <Button variant="ghost" class="token-hit-target text-muted-foreground">
        <Archive :stroke-width="1.75" />
        <span>存入归档</span>
      </Button>
      <Button variant="ghost" size="icon" class="token-hit-target text-muted-foreground" aria-label="更多操作">
        <Ellipsis :stroke-width="1.75" />
      </Button>
    </div>
  </header>
</template>
