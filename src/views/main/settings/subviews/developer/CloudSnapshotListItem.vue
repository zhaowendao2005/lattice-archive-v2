<script setup lang="ts">
/**
 * [VIEW] 单条云端日志快照元数据行 (CloudSnapshotListItem.vue)
 * 只读取 props 与 debugLoggerStore，零本地 ref；删除确认目标由 Store 托管。
 */
import { Button } from '@/components/ui/button';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';
import type { DebugSnapshotMeta } from '@/worker/remote/debug/types';

defineProps<{ snapshot: DebugSnapshotMeta }>();

const logger = useDebugLoggerStore();

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[index]}`;
}

function formatTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN');
}

function formatRange(minTime: number, maxTime: number): string {
  if (!minTime || !maxTime) return '—';
  const start = new Date(minTime);
  const end = new Date(maxTime);
  if (start.toDateString() === end.toDateString()) {
    return `${start.toLocaleDateString('zh-CN')} ${start.toLocaleTimeString('zh-CN')} ~ ${end.toLocaleTimeString('zh-CN')}`;
  }
  return `${formatTime(minTime)} ~ ${formatTime(maxTime)}`;
}
</script>

<template>
  <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
    <div class="min-w-0 space-y-1">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium text-foreground">
          {{ snapshot.entryCount.toLocaleString('zh-CN') }} 行日志
        </span>
        <span class="rounded-pill border border-border bg-muted px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          {{ snapshot.chunkCount }} 行 D1
        </span>
      </div>
      <div class="font-mono text-[11px] text-muted-foreground">
        {{ formatBytes(snapshot.sizeBytes) }} · Base64 {{ snapshot.sizeChars.toLocaleString('zh-CN') }} 字符
      </div>
      <div class="text-[11px] text-muted-foreground">
        时间范围：{{ formatRange(snapshot.minTime, snapshot.maxTime) }}
        · 提交于 {{ formatTime(snapshot.createdAt) }}
      </div>
    </div>
    <Button
      variant="destructive"
      size="xs"
      @click="logger.requestDeleteCloudSnapshot(snapshot.snapshotId)"
    >
      删除快照
    </Button>
  </div>
</template>
