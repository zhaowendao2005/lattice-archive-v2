<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useTelegramMonitorStore } from '@/stores/telegram/stores/telegramMonitorStore';
import type { MonitorEvent } from '@/worker/local/telegram/contracts/monitor';
import { formatClock } from './format';

const monitor = useTelegramMonitorStore();
const router = useRouter();

const KIND_LABELS: Record<MonitorEvent['kind'], string> = {
  flood_wait: '限流',
  unfreeze: '解除限流',
  backoff: '降速',
  recover: '恢复',
  scheduler_closed: '调度关闭',
  config_applied: '配置',
  connection: '连接',
  account_halted: '会话失效',
};
const KIND_CLS: Record<MonitorEvent['kind'], string> = {
  flood_wait: 'text-destructive',
  unfreeze: 'text-brand',
  backoff: 'text-foreground',
  recover: 'text-brand',
  scheduler_closed: 'text-muted-foreground',
  config_applied: 'text-muted-foreground',
  connection: 'text-muted-foreground',
  account_halted: 'text-destructive',
};

function openTrace(event: MonitorEvent) {
  if (!event.traceId) return;
  monitor.focusTrace(event.traceId);
  void router.push({ name: 'settings-developer-logs' });
}
</script>

<template>
  <section class="space-y-3">
    <span class="text-sm font-medium">
      事件 <span class="text-xs font-normal text-muted-foreground tabular-nums">{{ monitor.accountEvents.length }} 条</span>
    </span>
    <div class="max-h-64 overflow-y-auto rounded-xl border border-border bg-card divide-y divide-border text-xs">
      <p v-if="monitor.accountEvents.length === 0" class="px-3 py-6 text-center text-muted-foreground">暂无状态变化</p>
      <button
        v-for="event in monitor.accountEvents"
        :key="event.seq"
        type="button"
        :class="['flex w-full items-start gap-3 px-3 py-2 text-left', event.traceId ? 'hover:bg-muted' : 'cursor-default']"
        @click="openTrace(event)"
      >
        <span class="shrink-0 tabular-nums text-muted-foreground">{{ formatClock(event.at) }}</span>
        <span :class="['w-14 shrink-0 font-medium', KIND_CLS[event.kind]]">{{ KIND_LABELS[event.kind] }}</span>
        <span class="min-w-0 flex-1 break-words">{{ event.message }}</span>
      </button>
    </div>
  </section>
</template>
