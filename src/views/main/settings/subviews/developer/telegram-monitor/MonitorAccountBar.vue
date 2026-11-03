<script setup lang="ts">
import { useTelegramMonitorStore } from '@/stores/telegram/stores/telegramMonitorStore';
import { CONNECTION_LABELS, formatClock } from './format';

const monitor = useTelegramMonitorStore();
const DOT: Record<string, string> = {
  online: 'bg-brand',
  connecting: 'bg-muted-foreground',
  reconnecting: 'bg-muted-foreground',
  offline: 'bg-destructive',
  'auth-expired': 'bg-destructive',
  unknown: 'bg-border',
};
</script>

<template>
  <section class="space-y-3">
    <span class="text-sm font-medium">账号</span>
    <div v-if="monitor.accounts.length === 0" class="rounded-xl border border-dashed border-border p-4 text-xs text-muted-foreground">
      {{ monitor.snapshot.seq === 0 ? '正在等待 Worker 推送第一帧监控数据…' : '当前没有在线的 Telegram 账号' }}
    </div>
    <div v-else class="flex flex-wrap gap-2" role="radiogroup" aria-label="选择账号">
      <button
        v-for="item in monitor.accounts"
        :key="item.accountId"
        type="button"
        role="radio"
        :aria-checked="monitor.effectiveAccountId === item.accountId"
        :class="[
          'flex items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          monitor.effectiveAccountId === item.accountId ? 'border-brand bg-accent' : 'border-border bg-card hover:bg-muted',
        ]"
        @click="monitor.selectAccount(item.accountId)"
      >
        <span :class="['size-2 shrink-0 rounded-full', DOT[item.connection]]" />
        <span class="min-w-0">
          <span class="block truncate text-sm font-medium">{{ monitor.accountNames[item.accountId] ?? item.accountId }}</span>
          <span class="block text-xs text-muted-foreground tabular-nums">
            {{ item.tier === 'P0' ? '前台' : '温池' }} · {{ CONNECTION_LABELS[item.connection] }}
            <template v-if="item.dcId"> · DC{{ item.dcId }}</template>
            <template v-if="item.lastConnectionChangeAt"> · {{ formatClock(item.lastConnectionChangeAt) }}</template>
            <template v-if="!item.hasScheduler"> · 无调度</template>
          </span>
        </span>
      </button>
    </div>
  </section>
</template>
