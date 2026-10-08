<script setup lang="ts">
import { Archive } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/stores/app/stores/appStore';

const appStore = useAppStore();
</script>

<template>
  <main class="flex-1 flex flex-col items-center justify-center p-8 text-center overflow-y-auto">
    <div class="size-12 rounded-xl bg-muted text-muted-foreground flex items-center justify-center">
      <Archive class="size-6" :stroke-width="1.5" />
    </div>
    <h1 class="mt-5 text-base font-semibold tracking-tight">归档还是空的</h1>
    <p class="mt-2 max-w-sm text-sm text-muted-foreground leading-relaxed">
      在会话中标记并存入本地的内容会出现在这里。归档功能尚未开放。
    </p>
    <Button variant="outline" class="mt-6 token-control-height px-4" @click="appStore.setActiveTab('chats')">
      返回会话
    </Button>
  </main>
</template>
