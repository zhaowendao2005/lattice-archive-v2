<script setup lang="ts">
import { Database, HardDriveDownload } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-2xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">数据与归档</h2>
        <p class="mt-1 text-sm text-muted-foreground">本地离线 SQLite 引擎状态与数据备份管理</p>
      </header>

      <section class="space-y-3">
        <span class="text-sm font-medium">本地存储状态</span>
        <div class="p-4 rounded-xl border border-border bg-card space-y-4">
          <div class="flex items-center gap-3">
            <div class="size-10 rounded-lg bg-brand-soft text-brand flex items-center justify-center shrink-0">
              <Database class="size-5" :stroke-width="1.75" />
            </div>
            <div>
              <div class="text-sm font-medium">SQLite 本地持久化数据库</div>
              <p class="text-xs text-muted-foreground">离线全量缓存模式已就绪</p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 pt-2 text-xs">
            <div class="p-3 rounded-lg bg-muted/60 border border-border">
              <span class="text-muted-foreground block">会话总数</span>
              <span class="text-base font-semibold tabular-nums mt-0.5 block">{{ chatStore.sessions.length }}</span>
            </div>
            <div class="p-3 rounded-lg bg-muted/60 border border-border">
              <span class="text-muted-foreground block">离线状态</span>
              <span class="text-base font-semibold text-brand tabular-nums mt-0.5 block">SYNCED</span>
            </div>
          </div>
        </div>
      </section>

      <section class="space-y-3">
        <span class="text-sm font-medium">维护与重置</span>
        <div class="rounded-xl border border-dashed border-border p-6 text-center text-xs text-muted-foreground space-y-2">
          <HardDriveDownload class="size-6 mx-auto text-muted-foreground" :stroke-width="1.5" />
          <p>数据导出与本地 SQLite 清理功能即将在后继发布。</p>
        </div>
      </section>
    </div>
  </div>
</template>
