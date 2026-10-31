<script setup lang="ts">
import { ArrowRightFromLine } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <header class="h-14 shrink-0 flex items-center justify-between gap-3 px-5 border-b border-border">
    <div class="min-w-0 flex items-center gap-2.5">
      <Button
        v-if="chatStore.isSessionListCollapsed"
        variant="ghost"
        size="icon"
        class="token-hit-target shrink-0 text-muted-foreground"
        aria-label="展开会话列表"
        title="展开会话列表"
        @click="chatStore.toggleSessionList()"
      >
        <ArrowRightFromLine :stroke-width="1.75" />
      </Button>
      <span
        v-if="chatStore.activeHeader"
        class="size-8 shrink-0 rounded-full bg-brand-soft text-brand text-[11px] font-semibold flex items-center justify-center"
      >
        {{ chatStore.activeHeader.initials }}
      </span>
      <div class="min-w-0">
        <h2 class="text-sm font-semibold truncate">{{ chatStore.activeHeader?.title ?? '会话' }}</h2>
        <p class="text-xs text-muted-foreground truncate">{{ chatStore.activeHeader?.subtitle ?? chatStore.syncStatus.label }}</p>
      </div>
    </div>
  </header>
</template>
