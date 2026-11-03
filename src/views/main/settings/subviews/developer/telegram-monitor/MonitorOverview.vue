<script setup lang="ts">
import { useTelegramMonitorStore } from '@/stores/telegram/stores/telegramMonitorStore';

const monitor = useTelegramMonitorStore();
</script>

<template>
  <section class="grid grid-cols-2 gap-3 md:grid-cols-4">
    <div
      v-for="item in [
        { label: '账号总任务', value: monitor.account?.total ?? 0, limit: monitor.account?.totalLimit ?? 0 },
        { label: '媒体 RPC', value: monitor.account?.media ?? 0, limit: monitor.account?.mediaLimit ?? 0 },
        { label: '非媒体 RPC', value: monitor.account?.nonMedia ?? 0, limit: monitor.account?.nonMediaLimit ?? 0 },
        { label: '排队', value: monitor.account?.queued ?? 0, limit: 0 },
      ]"
      :key="item.label"
      class="rounded-xl border border-border bg-card p-3"
    >
      <span class="block text-xs text-muted-foreground">{{ item.label }}</span>
      <span class="mt-1 block text-lg font-semibold tabular-nums">
        {{ item.value }}<span v-if="item.limit" class="text-sm font-medium text-muted-foreground"> / {{ item.limit }}</span>
      </span>
      <span class="mt-2 block h-1 overflow-hidden rounded-full bg-muted">
        <span
          class="block h-full rounded-full bg-brand transition-[width] duration-150"
          :style="{ width: item.limit ? `${Math.min(100, (item.value / item.limit) * 100)}%` : '0%' }"
        />
      </span>
    </div>
  </section>
</template>
