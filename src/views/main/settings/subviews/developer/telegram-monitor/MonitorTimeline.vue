<script setup lang="ts">
import type { Directive } from 'vue';
import { telegramMonitorDataSource } from '@/stores/telegram/data-sources/telegramMonitorDataSource';

/** Canvas 句柄交给 Data Source 托管与重绘；曲线数据不经过 Vue。 */
const vMonitorCanvas: Directive<HTMLCanvasElement> = {
  mounted: (el) => telegramMonitorDataSource.attachCanvas(el),
  beforeUnmount: () => telegramMonitorDataSource.attachCanvas(null),
};

const LEGEND = [
  { label: '搜索', cls: 'bg-monitor-search' },
  { label: '封面与头像', cls: 'bg-monitor-cover' },
  { label: '文件分片', cls: 'bg-monitor-media' },
  { label: '视频流', cls: 'bg-monitor-stream' },
  { label: '限流', cls: 'bg-destructive' },
];
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-sm font-medium">最近 2 分钟</span>
      <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span v-for="item in LEGEND" :key="item.label" class="inline-flex items-center gap-1.5">
          <span :class="['h-0.5 w-3 rounded-full', item.cls]" />{{ item.label }}
        </span>
      </div>
    </div>
    <div class="rounded-xl border border-border bg-card p-3">
      <canvas v-monitor-canvas class="block h-56 w-full" aria-label="并发、排队与吞吐曲线" role="img" />
    </div>
  </section>
</template>
