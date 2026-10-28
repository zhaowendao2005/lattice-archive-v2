<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { Archive, MessagesSquare, PanelLeft, Settings } from '@lucide/vue';
import { useAppStore } from '@/stores/app/stores/appStore';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import AccountMenu from './AccountMenu.vue';
import SidebarNavItem from './SidebarNavItem.vue';

const appStore = useAppStore();
const authStore = useAuthStore();
const chatStore = useChatStore();

/** 折叠时文本仅靠 max-width / opacity 隐藏，节点始终驻留 */
const textClass = computed(() => [
  'overflow-hidden whitespace-nowrap text-left transition-[max-width,opacity,margin] duration-200',
  appStore.isSidebarCollapsed ? 'ml-0 max-w-0 opacity-0' : 'ml-2.5 max-w-44 opacity-100',
]);

// 账户菜单挂载在侧栏底部容器上，向上弹出
const accountAnchor = ref<HTMLElement | null>(null);

// 点击侧栏外部时收起菜单（菜单内点击不触发）
function handlePointerDown(event: MouseEvent) {
  const target = event.target as Node;
  if (accountAnchor.value?.contains(target)) return;
  authStore.closeAccountMenu();
}
document.addEventListener('pointerdown', handlePointerDown, true);
onBeforeUnmount(() => document.removeEventListener('pointerdown', handlePointerDown, true));
</script>

<template>
  <aside
    :class="[
      'flex flex-col shrink-0 overflow-hidden transition-[width] duration-200 ease-out',
      appStore.isSidebarCollapsed ? 'w-15' : 'w-72'
    ]"
  >
    <!-- 品牌 -->
    <div class="h-14 shrink-0 flex items-center px-2.5">
      <div class="mx-1.5 size-7 shrink-0 rounded-md bg-primary text-primary-foreground text-sm font-semibold flex items-center justify-center">
        L
      </div>
      <span :class="[textClass, 'text-sm font-semibold tracking-tight']">Lattice Archive</span>
    </div>

    <!-- 主导航 -->
    <nav class="flex-1 overflow-y-auto px-2.5 py-1 space-y-0.5">
      <RouterLink :to="{ name: 'chats' }" custom #default="{ navigate, isActive }">
        <SidebarNavItem
          :icon="MessagesSquare"
          label="会话"
          :badge="chatStore.sessions.length"
          :active="isActive"
          :collapsed="appStore.isSidebarCollapsed"
          @click="navigate"
        />
      </RouterLink>
      <RouterLink :to="{ name: 'archive' }" custom #default="{ navigate, isActive }">
        <SidebarNavItem
          :icon="Archive"
          label="归档"
          :active="isActive"
          :collapsed="appStore.isSidebarCollapsed"
          @click="navigate"
        />
      </RouterLink>
      <RouterLink :to="{ name: 'settings-platform' }" custom #default="{ navigate, isActive }">
        <SidebarNavItem
          :icon="Settings"
          label="设置"
          :active="isActive"
          :collapsed="appStore.isSidebarCollapsed"
          @click="navigate"
        />
      </RouterLink>
    </nav>

    <!-- 底部：折叠开关 + 账户入口 -->
    <div ref="accountAnchor" class="relative shrink-0 px-2.5 pb-2.5 space-y-0.5">
      <SidebarNavItem
        :icon="PanelLeft"
        :label="appStore.isSidebarCollapsed ? '展开侧栏' : '收起侧栏'"
        :collapsed="appStore.isSidebarCollapsed"
        @click="appStore.toggleSidebar()"
      />
      <button
        type="button"
        :title="authStore.displayName"
        :aria-expanded="authStore.isAccountMenuOpen"
        :aria-haspopup="'menu'"
        class="w-full flex items-center rounded-md p-1.5 text-left transition-colors hover:bg-accent/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        @click="authStore.toggleAccountMenu()"
      >
        <span class="size-7 shrink-0 rounded-full bg-brand-soft text-brand text-[11px] font-semibold flex items-center justify-center">
          {{ authStore.user?.initials ?? '?' }}
        </span>
        <span :class="textClass">
          <span class="block text-sm font-medium truncate">{{ authStore.displayName }}</span>
          <span class="block text-xs text-muted-foreground truncate">{{ authStore.displayRole }}</span>
        </span>
      </button>

      <!-- 账户菜单：向上弹出 -->
      <AccountMenu
        v-if="authStore.isAccountMenuOpen"
        :collapsed="appStore.isSidebarCollapsed"
        @close="authStore.closeAccountMenu()"
      />
    </div>
  </aside>
</template>
