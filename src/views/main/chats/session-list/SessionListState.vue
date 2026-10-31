<script setup lang="ts">
import { MessagesSquare } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <!-- 会话列表的非就绪状态：未绑定 / 加载骨架 / 错误 / 空列表 / 无匹配 -->
  <div v-if="chatStore.listState === 'loading'" class="space-y-1 px-1 pt-1" aria-busy="true" aria-label="正在加载会话">
    <div v-for="index in 8" :key="index" class="flex gap-3 rounded-lg px-3 py-2.5">
      <span class="size-10 shrink-0 animate-pulse rounded-full bg-muted" />
      <span class="flex-1 space-y-2 pt-1">
        <span class="block h-3 w-2/3 animate-pulse rounded bg-muted" />
        <span class="block h-3 w-full animate-pulse rounded bg-muted" />
      </span>
    </div>
  </div>

  <div v-else-if="chatStore.listState === 'no-account'" class="mx-2 mt-6 rounded-lg border border-border bg-muted/40 px-4 py-6 text-center">
    <MessagesSquare class="mx-auto size-6 text-muted-foreground" :stroke-width="1.75" />
    <p class="mt-3 text-sm font-medium">还没有可用的 Telegram 账户</p>
    <p class="mt-1 text-xs leading-relaxed text-muted-foreground">在设置中配置应用凭据、绑定账户并添加本设备后，会话会显示在这里。</p>
    <Button as-child variant="outline" size="sm" class="mt-4">
      <RouterLink :to="{ name: 'settings-telegram' }">前往绑定</RouterLink>
    </Button>
  </div>

  <div v-else-if="chatStore.listState === 'error'" class="mx-2 mt-6 rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-5 text-center">
    <p class="text-sm text-destructive">{{ chatStore.syncStatus.label }}</p>
    <Button variant="outline" size="sm" class="mt-3" @click="chatStore.retrySync()">重新连接</Button>
  </div>

  <p v-else class="px-4 py-10 text-center text-sm text-muted-foreground">
    {{ chatStore.listState === 'no-match' ? '没有匹配的会话' : '暂无会话' }}
  </p>
</template>
