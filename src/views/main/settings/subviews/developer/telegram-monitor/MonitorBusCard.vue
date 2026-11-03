<script setup lang="ts">
import type { MonitorBusCard } from '@/stores/telegram/stores/telegramMonitorStore';
import { LANE_LABELS } from '@/worker/local/telegram/contracts/monitor';
import { formatBytesRate, formatMs, formatRate } from './format';

defineProps<{ card: MonitorBusCard }>();

const BUS_DOT: Record<string, string> = {
  search: 'bg-monitor-search',
  cover: 'bg-monitor-cover',
  mediaAsset: 'bg-monitor-media',
  stream: 'bg-monitor-stream',
};
const STATUS: Record<MonitorBusCard['status'], { label: string; cls: string }> = {
  idle: { label: '空闲', cls: 'text-muted-foreground' },
  normal: { label: '运行中', cls: 'text-brand' },
  degraded: { label: '降速中', cls: 'text-foreground' },
  frozen: { label: '限流暂停', cls: 'text-destructive' },
};
</script>

<template>
  <article class="rounded-xl border border-border bg-card p-4 space-y-3">
    <header class="flex items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <span :class="['size-2 shrink-0 rounded-full', BUS_DOT[card.id] ?? 'bg-border']" />
        <span class="truncate text-sm font-medium">{{ card.label }}</span>
      </div>
      <span :class="['shrink-0 text-xs font-medium', card.wired ? STATUS[card.status].cls : 'text-muted-foreground']">
        {{ card.wired ? STATUS[card.status].label : '未接入调度' }}
      </span>
    </header>

    <template v-if="card.wired">
      <div class="grid grid-cols-4 gap-2 text-xs">
        <div><span class="block text-muted-foreground">活跃</span><span class="font-semibold tabular-nums">{{ card.active }}</span></div>
        <div><span class="block text-muted-foreground">排队</span><span class="font-semibold tabular-nums">{{ card.queued }}</span></div>
        <div><span class="block text-muted-foreground">完成/秒</span><span class="font-semibold tabular-nums">{{ formatRate(card.okRate) }}</span></div>
        <div><span class="block text-muted-foreground">吞吐</span><span class="font-semibold tabular-nums">{{ formatBytesRate(card.bytesRate) }}</span></div>
      </div>
      <table class="w-full text-xs tabular-nums">
        <thead class="text-muted-foreground">
          <tr class="text-left">
            <th class="py-1 font-medium">子池</th>
            <th class="py-1 font-medium">占用 / 有效 / 配置</th>
            <th class="py-1 font-medium">排队 p50·p95</th>
            <th class="py-1 font-medium">执行 p50·p95</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="lane in card.lanes" :key="lane.lane" class="border-t border-border">
            <td class="py-1.5">
              {{ LANE_LABELS[lane.lane] }}
              <span v-if="lane.status === 'frozen'" class="text-destructive"> · 暂停 {{ lane.frozenSeconds }} 秒</span>
              <span v-else-if="lane.status === 'degraded'" class="text-muted-foreground"> · 降速</span>
            </td>
            <td class="py-1.5">
              {{ lane.active }} / {{ lane.effective }} / {{ lane.configured }}
              <span v-if="lane.reservedActive !== undefined" class="text-muted-foreground"> · 搜索 {{ lane.reservedActive }}</span>
            </td>
            <td class="py-1.5">{{ formatMs(lane.queueMsP50) }} · {{ formatMs(lane.queueMsP95) }}</td>
            <td class="py-1.5">{{ formatMs(lane.runMsP50) }} · {{ formatMs(lane.runMsP95) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="card.errorRate > 0" class="text-xs text-destructive tabular-nums">失败 {{ formatRate(card.errorRate) }} 次/秒</p>
    </template>
    <p v-else class="text-xs text-muted-foreground">该总线的请求尚未迁入 RequestScheduler，迁移后会自动出现在这里。</p>
  </article>
</template>
