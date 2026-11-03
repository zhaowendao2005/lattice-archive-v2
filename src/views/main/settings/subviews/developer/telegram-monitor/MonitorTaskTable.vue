<script setup lang="ts">
import { useRouter } from 'vue-router';
import {
  MONITOR_TASK_ROW_PX,
  MONITOR_TASK_VIEWPORT_ROWS,
  useTelegramMonitorStore,
  type MonitorBusFilter,
  type MonitorStateFilter,
} from '@/stores/telegram/stores/telegramMonitorStore';
import { LANE_LABELS, MONITOR_BUSES, type MonitorTask } from '@/worker/local/telegram/contracts/monitor';
import { PRIORITY_LABELS, TASK_STATE_LABELS, formatBytes, formatMs } from './format';

const monitor = useTelegramMonitorStore();
const router = useRouter();

const BUS_OPTIONS: { value: MonitorBusFilter; label: string }[] = [
  { value: 'all', label: '全部总线' },
  ...MONITOR_BUSES.filter((bus) => bus.lanes.length > 0).map((bus) => ({ value: bus.id as MonitorBusFilter, label: bus.label.split(' ')[0]! })),
];
const STATE_OPTIONS: { value: MonitorStateFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'live', label: '进行中' },
  { value: 'done', label: '已完成' },
  { value: 'failed', label: '失败 / 取消' },
];
const STATE_CLS: Record<MonitorTask['state'], string> = {
  queued: 'text-muted-foreground',
  running: 'text-brand',
  ok: 'text-foreground',
  error: 'text-destructive',
  cancelled: 'text-muted-foreground',
};
const SELECT = 'h-8 rounded-lg border border-border bg-card px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring';

function waitMs(task: MonitorTask) { return (task.startedAt ?? task.endedAt ?? monitor.snapshot.receivedAt) - task.enqueuedAt; }
function runMs(task: MonitorTask) { return task.startedAt ? (task.endedAt ?? monitor.snapshot.receivedAt) - task.startedAt : 0; }

function openTrace(task: MonitorTask) {
  monitor.focusTrace(task.traceId);
  void router.push({ name: 'settings-developer-logs' });
}
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <span class="text-sm font-medium">
        任务
        <span class="text-xs font-normal text-muted-foreground tabular-nums">
          {{ monitor.taskSlice.total }} 条<template v-if="monitor.snapshot.hiddenTaskCount"> · 另有 {{ monitor.snapshot.hiddenTaskCount }} 个活跃任务未展示</template>
        </span>
      </span>
      <div class="flex items-center gap-2">
        <select :class="SELECT" aria-label="按总线筛选" :value="monitor.busFilter" @change="monitor.setBusFilter(($event.target as HTMLSelectElement).value as MonitorBusFilter)">
          <option v-for="option in BUS_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
        <select :class="SELECT" aria-label="按状态筛选" :value="monitor.stateFilter" @change="monitor.setStateFilter(($event.target as HTMLSelectElement).value as MonitorStateFilter)">
          <option v-for="option in STATE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
        </select>
      </div>
    </div>
    <div class="overflow-hidden rounded-xl border border-border bg-card text-xs tabular-nums">
      <div class="grid grid-cols-[4.5rem_5rem_minmax(0,1fr)_3rem_3.5rem_4.5rem_4.5rem_5.5rem] gap-2 border-b border-border px-3 py-2 font-medium text-muted-foreground">
        <span>任务</span><span>子池</span><span>操作</span><span>优先级</span><span>状态</span><span>排队</span><span>执行</span><span>进度 / 结果</span>
      </div>
      <div
        class="overflow-y-auto"
        :style="{ height: `${MONITOR_TASK_ROW_PX * MONITOR_TASK_VIEWPORT_ROWS}px` }"
        @scroll.passive="monitor.handleTaskScroll($event)"
      >
        <div :style="{ height: `${monitor.taskSlice.topPx}px` }" />
        <button
          v-for="task in monitor.taskSlice.rows"
          :key="task.id"
          type="button"
          class="grid w-full grid-cols-[4.5rem_5rem_minmax(0,1fr)_3rem_3.5rem_4.5rem_4.5rem_5.5rem] items-center gap-2 px-3 text-left transition-colors hover:bg-muted"
          :style="{ height: `${MONITOR_TASK_ROW_PX}px` }"
          :title="`跳转日志：${task.traceId}`"
          @click="openTrace(task)"
        >
          <span class="truncate text-muted-foreground">#{{ task.id }}</span>
          <span class="truncate">{{ LANE_LABELS[task.lane] }}</span>
          <span class="truncate">{{ task.operation }}</span>
          <span>{{ PRIORITY_LABELS[task.priority] }}</span>
          <span :class="STATE_CLS[task.state]">{{ TASK_STATE_LABELS[task.state] }}</span>
          <span>{{ formatMs(waitMs(task)) }}</span>
          <span>{{ formatMs(runMs(task)) }}</span>
          <span class="truncate" :class="task.bucket ? 'text-destructive' : ''">
            <template v-if="task.bucket">{{ task.bucket }}</template>
            <template v-else-if="task.total">{{ formatBytes(task.loaded ?? 0) }} / {{ formatBytes(task.total) }}</template>
            <template v-else>—</template>
          </span>
        </button>
        <div :style="{ height: `${monitor.taskSlice.bottomPx}px` }" />
        <p v-if="monitor.taskSlice.total === 0" class="px-3 py-6 text-center text-muted-foreground">暂无任务</p>
      </div>
    </div>
  </section>
</template>
