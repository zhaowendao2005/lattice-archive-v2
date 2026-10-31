<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <!-- 消息流的非就绪状态：加载骨架 / 等待连接 / 错误 / 空会话 -->
  <div v-if="chatStore.feedState === 'loading'" class="space-y-4 pt-4" aria-busy="true" aria-label="正在加载消息">
    <div v-for="index in 6" :key="index" :class="['flex', index % 3 === 0 ? 'justify-end' : 'justify-start']">
      <span :class="['h-10 animate-pulse rounded-2xl bg-muted', index % 2 === 0 ? 'w-1/2' : 'w-2/5']" />
    </div>
  </div>

  <div v-else-if="chatStore.feedState === 'error'" class="mx-auto mt-16 max-w-sm rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-5 text-center">
    <p class="text-sm text-destructive">{{ chatStore.activeWindow?.error }}</p>
    <Button variant="outline" size="sm" class="mt-3" @click="chatStore.retryActive()">重试</Button>
  </div>

  <p v-else-if="chatStore.feedState === 'waiting'" class="py-16 text-center text-sm text-muted-foreground">
    {{ chatStore.syncPhase === 'offline' ? chatStore.syncStatus.label : '连接 Telegram 后将自动加载消息…' }}
  </p>

  <p v-else class="py-16 text-center text-sm text-muted-foreground">这个会话还没有消息</p>
</template>
