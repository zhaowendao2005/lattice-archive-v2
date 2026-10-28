<script setup lang="ts">
import { watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { useAppStore } from '@/stores/app/stores/appStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import AppSidebar from './AppSidebar.vue';

const appStore = useAppStore();
const chatStore = useChatStore();
const isCompactWidth = useMediaQuery('(width < 1024px)');
const isNarrowWidth = useMediaQuery('(width < 768px)');

// 仅在跨越断点时自动折叠，窄屏内仍允许用户手动展开。
let sidebarCollapsedBeforeCompact = appStore.isSidebarCollapsed;
let sessionListCollapsedBeforeNarrow = chatStore.isSessionListCollapsed;

watch(isCompactWidth, (compact) => {
  if (compact) {
    sidebarCollapsedBeforeCompact = appStore.isSidebarCollapsed;
    appStore.setSidebarCollapsed(true);
  } else {
    appStore.setSidebarCollapsed(sidebarCollapsedBeforeCompact);
  }
}, { immediate: true });

watch(isNarrowWidth, (narrow) => {
  if (narrow) {
    sessionListCollapsedBeforeNarrow = chatStore.isSessionListCollapsed;
    chatStore.isSessionListCollapsed = true;
  } else {
    chatStore.isSessionListCollapsed = sessionListCollapsedBeforeNarrow;
  }
}, { immediate: true });
</script>

<template>
  <div class="relative h-screen min-h-0 w-screen flex bg-background text-foreground antialiased pt-[var(--safe-top)] pb-[var(--safe-bottom)] overflow-hidden">
    <button
      v-if="isCompactWidth && !appStore.isSidebarCollapsed"
      type="button"
      class="absolute inset-0 z-30 bg-black/30"
      aria-label="收起应用侧栏"
      @click="appStore.setSidebarCollapsed(true)"
    />
    <div class="relative w-15 shrink-0 min-[1024px]:w-auto">
      <AppSidebar
        :class="[
          'h-full bg-background',
          isCompactWidth ? 'absolute inset-y-0 left-0 z-40' : '',
          isCompactWidth && !appStore.isSidebarCollapsed ? 'shadow-xl' : ''
        ]"
        @keydown.esc="appStore.setSidebarCollapsed(true)"
      />
    </div>

    <!-- 内容面板：铺满高度的白色工作区；子路由由 RouterView 承接 -->
    <div class="flex-1 min-w-0 min-h-0 flex my-3 mr-3 rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <RouterView v-slot="{ Component }">
        <KeepAlive :max="8">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
    </div>
  </div>
</template>
