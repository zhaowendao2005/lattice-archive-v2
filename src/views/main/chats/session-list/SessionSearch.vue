<!--
  会话搜索框（受控输入）
  说明：除了本地筛选已加载的会话，输入 @username / t.me/xxx 时
  Store 会额外发起一次远端解析（见 chatStore.resolvePublicUsername）。
-->
<script setup lang="ts">
import { Search } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();

function handleInput(event: Event) {
  // 直接把输入写给 Store（含防抖的远端解析都在 Store 内）
  const target = event.target as HTMLInputElement;
  chatStore.setSearchKeyword(target.value);
}
</script>

<template>
  <div class="relative flex items-center">
    <Search class="absolute left-3 size-4 text-muted-foreground pointer-events-none" :stroke-width="1.75" />
    <input
      type="search"
      :value="chatStore.searchKeyword"
      placeholder="筛选已加载的会话"
      class="w-full token-control-height rounded-lg border border-transparent bg-muted pl-9 pr-3 outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-card"
      @input="handleInput"
    />
  </div>
</template>
