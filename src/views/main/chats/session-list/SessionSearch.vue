<script setup lang="ts">
import { Search } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();

function handleInput(event: Event) {
  const target = event.target as HTMLInputElement;
  chatStore.setSearchKeyword(target.value);
}
</script>

<template>
  <div class="relative flex items-center">
    <Search class="absolute left-3 size-4 text-muted-foreground pointer-events-none" :stroke-width="1.75" />
    <input
      type="text"
      :value="chatStore.searchKeyword"
      placeholder="搜索会话、消息或标签"
      class="w-full token-control-height rounded-lg border border-transparent bg-muted pl-9 pr-3 outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-card"
      @input="handleInput"
    />
  </div>
</template>
