<script setup lang="ts">
import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';
import { Pause, Play, Trash2, UploadCloud } from '@lucide/vue';
import { useTelegramMonitorStore } from '@/stores/telegram/stores/telegramMonitorStore';
import { MONITOR_HZ_OPTIONS } from '@/worker/local/telegram/contracts/monitor';
import MonitorAccountBar from './MonitorAccountBar.vue';
import MonitorOverview from './MonitorOverview.vue';
import MonitorBusCard from './MonitorBusCard.vue';
import MonitorTimeline from './MonitorTimeline.vue';
import MonitorTaskTable from './MonitorTaskTable.vue';
import MonitorEventFeed from './MonitorEventFeed.vue';

const monitor = useTelegramMonitorStore();
const TOOL_BTN = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring';

// 订阅生命周期跟随页面可见：挂载 / KeepAlive 激活时订阅，离开时退订（Worker 随即停止推送）。
onMounted(() => monitor.open());
onActivated(() => monitor.open());
onDeactivated(() => monitor.close());
onBeforeUnmount(() => monitor.close());
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-5xl px-8 py-8 space-y-6">
      <header class="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 class="text-lg font-semibold tracking-tight text-foreground">Telegram 连接监控</h2>
          <p class="mt-1 text-sm text-muted-foreground">
            业务总线、调度子池与任务的实时状态 · 并发模式 {{ monitor.modeLabel }}
            <span v-if="monitor.snapshot.stale" class="text-destructive"> · 数据已过期，等待 Worker 推送</span>
            <span v-else-if="monitor.paused" class="text-muted-foreground"> · 已暂停</span>
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex h-8 overflow-hidden rounded-lg border border-border" role="radiogroup" aria-label="刷新频率">
            <button
              v-for="rate in MONITOR_HZ_OPTIONS"
              :key="rate"
              type="button"
              role="radio"
              :aria-checked="monitor.hz === rate"
              :class="['px-2.5 text-xs tabular-nums transition-colors', monitor.hz === rate ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-muted']"
              @click="monitor.setHz(rate)"
            >
              {{ rate }} 帧/秒
            </button>
          </div>
          <button type="button" :class="TOOL_BTN" @click="monitor.togglePause()">
            <component :is="monitor.paused ? Play : Pause" class="size-3.5" :stroke-width="1.75" />{{ monitor.paused ? '继续' : '暂停' }}
          </button>
          <button type="button" :class="TOOL_BTN" @click="monitor.clear()">
            <Trash2 class="size-3.5" :stroke-width="1.75" />清空
          </button>
          <button type="button" :class="TOOL_BTN" @click="monitor.exportToCloud()">
            <UploadCloud class="size-3.5" :stroke-width="1.75" />{{ monitor.isExporting ? '导出中…' : '导出到云端快照' }}
          </button>
        </div>
      </header>
      <p v-if="monitor.exportNotice || monitor.exportError" role="status" :class="['text-xs', monitor.exportError ? 'text-destructive' : 'text-muted-foreground']">
        {{ monitor.exportError || monitor.exportNotice }}
      </p>

      <MonitorAccountBar />
      <MonitorOverview />

      <section class="space-y-3">
        <span class="text-sm font-medium">业务总线</span>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <MonitorBusCard v-for="card in monitor.busCards" :key="card.id" :card="card" />
        </div>
      </section>

      <MonitorTimeline />
      <MonitorTaskTable />
      <MonitorEventFeed />
    </div>
  </div>
</template>
