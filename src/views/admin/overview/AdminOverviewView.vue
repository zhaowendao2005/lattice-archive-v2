<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { ArrowLeft, Database, Users } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth/stores/authStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const authStore = useAuthStore();
const chatStore = useChatStore();
const router = useRouter();

const stats = computed(() => [
  { label: '会话总数', value: chatStore.sessions.length, icon: Database },
  { label: '当前账户', value: authStore.user?.name ?? '—', icon: Users },
]);
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-3xl px-8 py-8 space-y-8">
      <header class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold tracking-tight">管理员控制台</h2>
          <p class="mt-1 text-sm text-muted-foreground">系统级监控与维护入口</p>
        </div>
        <Button variant="outline" size="sm" @click="router.push({ name: 'chats' })">
          <ArrowLeft class="size-4" :stroke-width="1.75" />
          返回工作区
        </Button>
      </header>

      <section class="grid grid-cols-2 gap-3">
        <div
          v-for="s in stats"
          :key="s.label"
          class="p-4 rounded-xl border border-border bg-card flex items-center gap-3"
        >
          <div class="size-10 shrink-0 rounded-lg bg-brand-soft text-brand flex items-center justify-center">
            <component :is="s.icon" class="size-5" :stroke-width="1.75" />
          </div>
          <div class="min-w-0">
            <div class="text-xs text-muted-foreground">{{ s.label }}</div>
            <div class="mt-0.5 text-base font-semibold truncate">{{ s.value }}</div>
          </div>
        </div>
      </section>

      <section class="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground space-y-2">
        <p>用户管理、权限配置与审计日志将在后继版本提供。</p>
        <p>管理员身份：{{ authStore.user?.role === 'admin' ? '已验证' : '未验证' }}</p>
      </section>
    </div>
  </div>
</template>
