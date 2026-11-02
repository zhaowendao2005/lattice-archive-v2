<!--
  ============================================================================
  工作区外壳（/workspace 下所有页面的公共骨架）
  ============================================================================
  结构：左侧 AppSidebar（可折叠）+ 右侧白色内容面板（RouterView）。
  注意：
  · 这里的 KeepAlive 会让聊天/设置页面在切换后保留状态，因此子页不应假设
    卸载时就会清理定时器（清理写在 onBeforeUnmount 里同样会执行）；
  · 窄屏（<1024px）侧栏变成抽屉，用一个遮罩层模拟点击外部关闭；
  · 侧栏折叠状态放在 appStore，会话列表折叠放在 chatStore（两者粒度不同）。
-->
<script setup lang="ts">
import { watch } from 'vue';
import { useMediaQuery } from '@vueuse/core';
import { Loader2 } from '@lucide/vue';
import { useAppStore } from '@/stores/app/stores/appStore';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import AppSidebar from './AppSidebar.vue';

const appStore = useAppStore();
const debugLogger = useDebugLoggerStore();
const authStore = useAuthStore();
const chatStore = useChatStore();
const isCompactWidth = useMediaQuery('(width < 1024px)'); // 平板竖屏/手机：侧栏变抽屉
const isNarrowWidth = useMediaQuery('(width < 768px)');   // 手机：会话列表也收起

// 工作区级引导（在子页面挂载前执行）：恢复本机 Telegram 连接、挂载调试采集桥并加载该用户的聊天缓存。
// 放在 AppLayout 而不是 ChatsView，是为了让「设置页」等其它子页也能提前完成连接。
debugLogger.initialize();
if (authStore.user) chatStore.initialize(authStore.user.id);

// 仅在跨越断点时自动折叠，窄屏内仍允许用户手动展开。
// 记住跨越前的状态，回到宽屏时原样恢复，避免用户手动展开/收起的结果被覆盖。
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
  <!-- 整体锁定视口高度（h-screen + overflow-hidden），滚动只发生在内部子区域 -->
  <div class="relative h-screen min-h-0 w-screen flex bg-background text-foreground antialiased pt-[var(--safe-top)] pb-[var(--safe-bottom)] overflow-hidden">
    <!-- 窄屏抽屉打开时的遮罩：点击即收起侧栏 -->
    <button
      v-if="isCompactWidth && !appStore.isSidebarCollapsed"
      type="button"
      class="absolute inset-0 z-30 bg-black/30"
      aria-label="收起应用侧栏"
      @click="appStore.setSidebarCollapsed(true)"
    />
    <div class="relative w-15 shrink-0 min-[1024px]:w-auto">
      <!-- 宽屏：普通列（宽度由自身 w-15 / w-72 控制）；窄屏：绝对定位抽屉 -->
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
    <div class="relative flex-1 min-w-0 min-h-0 flex my-3 mr-3 rounded-2xl border border-border bg-card shadow-sm overflow-hidden">
      <RouterView v-slot="{ Component }">
        <KeepAlive :max="8">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>

      <!--
        分区切换缓冲层（会话 / 归档 / 设置）：DOM 常驻，仅切换 opacity。
        进入带 100ms 延迟，已缓存分区的瞬时切换不会闪烁；撤下时的淡出即新页面的淡入。
        只动 opacity / transform，主线程忙于挂载新页面时动画仍由合成线程驱动。
      -->
      <div
        :aria-hidden="!appStore.isSectionSwitching"
        :class="[
          'absolute inset-0 z-20 flex items-center justify-center bg-card will-change-[opacity] transition-opacity',
          appStore.isSectionSwitching ? 'opacity-100 duration-150 delay-100' : 'pointer-events-none opacity-0 duration-200'
        ]"
      >
        <div class="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-brand-soft">
          <div class="h-full w-1/3 origin-left bg-brand animate-route-progress" />
        </div>
        <Loader2 class="size-5 animate-spin text-muted-foreground" :stroke-width="1.75" />
      </div>
    </div>
  </div>
</template>
