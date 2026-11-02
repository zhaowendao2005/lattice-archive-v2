<script setup lang="ts">
/**
 * [VIEW] 云端日志快照管理卡片 (CloudDebugSnapshotPanel.vue)
 * 严格遵循零本地 ref / reactive 与语义化视觉令牌规范：
 * 所有开关、列表、加载、错误与删除确认状态均来自 debugLoggerStore。
 */
import { Cloud, RefreshCw } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';
import CloudSnapshotDeleteDialog from './CloudSnapshotDeleteDialog.vue';
import CloudSnapshotListItem from './CloudSnapshotListItem.vue';

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
</script>

<template>
  <section class="space-y-3">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="flex items-start gap-3">
        <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
          <Cloud class="size-5" :stroke-width="1.75" />
        </div>
        <div>
          <div class="text-sm font-medium text-foreground">云 · 日志快照</div>
          <p class="mt-0.5 max-w-2xl text-xs leading-relaxed text-muted-foreground">
            每次手动同步生成一条归属于当前账号的快照记录；查询时忽略提交边界，按整体日志时间线合并。
            单条快照按 D1 单行 2 MB 上限自动拆分为尽可能少的连续分片行。
          </p>
        </div>
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <span class="text-xs text-muted-foreground">云端日志记录</span>
        <button
          type="button"
          role="switch"
          aria-label="云端日志记录"
          :aria-checked="logger.cloudLoggingEnabled"
          :class="[
            'relative h-6 w-10 shrink-0 rounded-full transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
            logger.cloudLoggingEnabled ? 'bg-brand' : 'bg-input',
          ]"
          @click="logger.setCloudLoggingEnabled(!logger.cloudLoggingEnabled)"
        >
          <span
            :class="[
              'absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-150',
              logger.cloudLoggingEnabled ? 'translate-x-4' : 'translate-x-0',
            ]"
          />
        </button>
      </div>
    </div>

    <div class="overflow-hidden rounded-xl border border-border bg-card">
      <div class="grid grid-cols-3 divide-x divide-border border-b border-border">
        <div class="px-4 py-3">
          <span class="block text-xs text-muted-foreground">快照记录</span>
          <span class="mt-0.5 block text-base font-semibold tabular-nums text-foreground">
            {{ logger.cloudSnapshotCount }}
          </span>
        </div>
        <div class="px-4 py-3">
          <span class="block text-xs text-muted-foreground">日志行数</span>
          <span class="mt-0.5 block text-base font-semibold tabular-nums text-foreground">
            {{ logger.cloudSnapshotTotalEntries.toLocaleString('zh-CN') }}
          </span>
        </div>
        <div class="px-4 py-3">
          <span class="block text-xs text-muted-foreground">云端空间</span>
          <span class="mt-0.5 block text-base font-semibold tabular-nums text-foreground">
            {{ formatBytes(logger.cloudSnapshotTotalSizeBytes) }}
          </span>
          <span class="block text-[11px] text-muted-foreground">
            {{ logger.cloudSnapshotTotalRows }} 行 D1 存储 · 压缩载荷
          </span>
        </div>
      </div>

      <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span class="text-xs text-muted-foreground">
          <template v-if="logger.isPushingSnapshot">正在压缩并提交当前日志…</template>
          <template v-else-if="logger.lastSnapshotPushedAt">
            最近一次提交：{{ formatTime(logger.lastSnapshotPushedAt) }}
          </template>
          <template v-else>尚未提交云端日志快照</template>
        </span>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :aria-busy="logger.isLoadingCloudSnapshots"
            @click="logger.loadCloudSnapshots()"
          >
            <RefreshCw class="size-3.5" :class="{ 'animate-spin': logger.isLoadingCloudSnapshots }" />
            刷新
          </Button>
          <Button
            size="sm"
            :aria-busy="logger.isPushingSnapshot"
            @click="logger.pushSnapshotNow()"
          >
            {{ logger.isPushingSnapshot ? '正在同步…' : '手动同步' }}
          </Button>
        </div>
      </div>

      <div v-if="!logger.cloudAccountId" class="px-4 py-8 text-center text-xs text-muted-foreground">
        请先登录后再管理云端日志快照。
      </div>
      <template v-else>
        <div
          v-if="logger.cloudError"
          role="alert"
          class="mx-4 my-3 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {{ logger.cloudError }}
        </div>
        <div
          v-if="logger.isLoadingCloudSnapshots && !logger.cloudLoaded"
          class="px-4 py-8 text-center text-xs text-muted-foreground"
        >
          正在读取云端快照元数据…
        </div>
        <div
          v-else-if="logger.cloudSnapshots.length === 0 && !logger.cloudError"
          class="px-4 py-8 text-center text-xs text-muted-foreground"
        >
          暂无云端日志快照。开启上方开关后点击「手动同步」即可提交当前本地日志。
        </div>
        <div v-else-if="logger.cloudSnapshots.length > 0" class="divide-y divide-border">
          <CloudSnapshotListItem
            v-for="snapshot in logger.cloudSnapshots"
            :key="snapshot.snapshotId"
            :snapshot="snapshot"
          />
        </div>
      </template>

      <div
        v-if="logger.cloudNotice"
        class="border-t border-border bg-muted/40 px-4 py-2 text-xs text-brand"
      >
        {{ logger.cloudNotice }}
      </div>
    </div>

    <CloudSnapshotDeleteDialog />
  </section>
</template>
