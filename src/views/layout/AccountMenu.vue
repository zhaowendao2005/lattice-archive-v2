<script setup lang="ts">
import { LogOut, ShieldCheck } from '@lucide/vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth/stores/authStore';

defineProps<{
  /** 侧栏折叠时菜单需要偏移到侧栏右侧，避免被裁切 */
  collapsed?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const authStore = useAuthStore();
const router = useRouter();

function goToAdminLogin() {
  authStore.closeAccountMenu();
  router.push({ name: 'admin-login' });
}

function handleLogout() {
  authStore.logout();
  authStore.closeAccountMenu();
  router.push({ name: 'auth-login' });
}
</script>

<template>
  <div
    role="menu"
    :class="[
      'absolute bottom-full mb-1.5 z-50 w-56 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-xl',
      collapsed ? 'left-0' : 'left-0 right-0'
    ]"
  >
    <!-- 身份摘要 -->
    <div class="flex items-center gap-2.5 px-2.5 py-2">
      <span class="size-8 shrink-0 rounded-full bg-brand-soft text-brand text-[11px] font-semibold flex items-center justify-center">
        {{ authStore.user?.initials ?? '?' }}
      </span>
      <span class="min-w-0">
        <span class="block text-sm font-medium truncate">{{ authStore.displayName }}</span>
        <span class="block text-xs text-muted-foreground truncate">{{ authStore.displayRole }}</span>
      </span>
    </div>

    <div class="my-1 h-px bg-border" />

    <button
      type="button"
      role="menuitem"
      class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
      @click="goToAdminLogin"
    >
      <ShieldCheck class="size-4 shrink-0" :stroke-width="1.75" />
      <span>切换到管理员登录</span>
    </button>

    <button
      type="button"
      role="menuitem"
      class="w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-destructive/10 hover:text-destructive outline-none focus-visible:ring-2 focus-visible:ring-ring"
      @click="handleLogout"
    >
      <LogOut class="size-4 shrink-0" :stroke-width="1.75" />
      <span>退出</span>
    </button>
  </div>
</template>
