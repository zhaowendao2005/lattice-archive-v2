<script setup lang="ts">
import { useRouter } from 'vue-router';
import { LogOut, ShieldCheck } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth/stores/authStore';
const auth = useAuthStore();
const router = useRouter();
async function logout() { await auth.logout(); await router.replace({ name: 'admin-login' }); }
</script>

<template>
  <div class="flex h-dvh w-full flex-col overflow-hidden bg-background pt-[var(--safe-top)] pb-[var(--safe-bottom)]">
    <header class="shrink-0 border-b border-border bg-card">
      <div class="mx-auto flex min-h-16 max-w-7xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6 lg:px-8">
        <RouterLink :to="{ name: 'admin-users' }" class="flex items-center gap-2 font-semibold"><ShieldCheck class="size-5 text-brand" />管理控制台</RouterLink>
        <nav aria-label="管理导航" class="flex items-center gap-1 text-sm">
          <RouterLink :to="{ name: 'admin-users' }" class="rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" active-class="bg-brand-soft font-medium text-brand">用户管理</RouterLink>
          <RouterLink :to="{ name: 'admin-overview' }" class="rounded-lg px-3 py-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" active-class="bg-brand-soft font-medium text-brand">概览</RouterLink>
        </nav>
        <div class="ml-auto flex items-center gap-3">
          <span class="hidden max-w-48 truncate text-xs text-muted-foreground md:inline">{{ auth.user?.email }}</span>
          <Button variant="ghost" size="sm" @click="logout"><LogOut class="size-4" />退出</Button>
        </div>
      </div>
    </header>
    <main class="min-h-0 flex-1 overflow-y-auto"><RouterView /></main>
  </div>
</template>
