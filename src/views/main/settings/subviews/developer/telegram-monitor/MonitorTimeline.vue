<script setup lang="ts">
import type { Directive } from 'vue';
import { Radio, Table2 } from '@lucide/vue';
import { useTelegramMonitorStore } from '@/stores/telegram/stores/telegramMonitorStore';
import { telegramMonitorDataSource } from '@/stores/telegram/data-sources/telegramMonitorDataSource';
import type { SeriesMetric } from '@/stores/telegram/data-sources/monitorSeries';

/** ECharts 实例、降采样与重绘都交给 Data Source 托管；曲线数组不经过 Vue 响应式。 */
const vMonitorChart: Directive<HTMLElement, SeriesMetric> = {
  mounted: (el, binding) => { void telegramMonitorDataSource.attachChart(binding.value, el); },
  beforeUnmount: (_el, binding) => { telegramMonitorDataSource.detachChart(binding.value); },
};

const monitor = useTelegramMonitorStore();
const TOOL_BTN = 'inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring';

const CHARTS: { metric: SeriesMetric; title: string; hint: string }[] = [
  { metric: 'concurrency', title: '总线并发数', hint: '当前 active 请求，不含完整文件任务数' },
  { metric: 'requests', title: '总线请求速率', hint: '终态请求 / 秒（成功 + 失败 + 取消）' },
  { metric: 'throughput', title: '总线字节吞吐', hint: '已埋点的应用层下载吞吐（封面 / 文件分片 / 视频流）' },
];
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-baseline gap-3">
        <span class="text-sm font-medium">时间序列</span>
        <span class="text-xs text-muted-foreground">
          {{ monitor.zoomLabel }} · 曲线数据常驻内存 {{ monitor.chartMemoryLabel }}
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" :class="TOOL_BTN" @click="monitor.returnToLive()">
          <Radio class="size-3.5" :stroke-width="1.75" />回到实时
        </button>
        <button type="button" :class="TOOL_BTN" :aria-pressed="monitor.showTable" @click="monitor.toggleTable()">
          <Table2 class="size-3.5" :stroke-width="1.75" />数据表
        </button>
      </div>
    </div>

    <p class="text-[11px] text-muted-foreground">
      三条曲线分别独立成图；点击图例可隐藏任意总线，隐藏后仍持续采样。拖动下方滑块或滚轮缩放可固定查看历史区间。
    </p>

    <div v-for="chart in CHARTS" :key="chart.metric" class="rounded-xl border border-border bg-card p-3">
      <div class="mb-1 flex flex-wrap items-baseline gap-2">
        <span class="text-xs font-medium text-foreground">{{ chart.title }}</span>
        <span class="text-[11px] text-muted-foreground">{{ chart.hint }}</span>
      </div>
      <div
        v-monitor-chart="chart.metric"
        class="h-56 w-full"
        role="img"
        :aria-label="chart.title"
      />
    </div>

    <div v-if="monitor.showTable" class="overflow-x-auto rounded-xl border border-border bg-card">
      <table class="w-full text-left text-xs">
        <thead class="border-b border-border text-muted-foreground">
          <tr>
            <th class="px-3 py-2 font-medium">总线</th>
            <th class="px-3 py-2 font-medium tabular-nums">并发</th>
            <th class="px-3 py-2 font-medium tabular-nums">请求 / 秒</th>
            <th class="px-3 py-2 font-medium tabular-nums">吞吐</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="card in monitor.busCards" :key="card.id" class="border-b border-border/60 last:border-0">
            <td class="px-3 py-1.5">{{ card.label }}</td>
            <td class="px-3 py-1.5 tabular-nums">{{ card.active }}</td>
            <td class="px-3 py-1.5 tabular-nums">{{ card.requestsRate.toFixed(1) }}</td>
            <td class="px-3 py-1.5 tabular-nums">{{ telegramMonitorDataSource.formatRate(card.bytesRate) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
