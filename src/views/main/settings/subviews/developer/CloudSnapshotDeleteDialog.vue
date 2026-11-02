<script setup lang="ts">
/**
 * [VIEW] 删除云端日志快照确认弹窗 (CloudSnapshotDeleteDialog.vue)
 * 确认态、请求态和错误态全部来自 debugLoggerStore；视图零本地 ref。
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { Button } from '@/components/ui/button';
import { useDebugLoggerStore } from '@/stores/app/stores/debugLoggerStore';

const logger = useDebugLoggerStore();

function formatTime(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('zh-CN');
}
</script>

<template>
  <DialogRoot
    :open="!!logger.pendingDeleteSnapshotId"
    @update:open="(open) => { if (!open) logger.cancelDeleteCloudSnapshot(); }"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-xl"
        @escape-key-down="(event) => { if (logger.isDeletingCloudSnapshot) event.preventDefault(); }"
        @interact-outside="(event) => { if (logger.isDeletingCloudSnapshot) event.preventDefault(); }"
      >
        <DialogTitle class="text-lg font-semibold">删除云端日志快照</DialogTitle>
        <DialogDescription class="mt-2 text-sm leading-relaxed text-muted-foreground">
          确定删除提交于
          <strong class="font-semibold text-foreground">
            {{ formatTime(logger.pendingDeleteSnapshot?.createdAt ?? 0) }}
          </strong>
          的
          <strong class="font-semibold text-foreground">
            {{ (logger.pendingDeleteSnapshot?.entryCount ?? 0).toLocaleString('zh-CN') }} 行日志
          </strong>
          快照？该快照的
          <strong class="font-semibold text-foreground">
            {{ logger.pendingDeleteSnapshot?.chunkCount ?? 0 }} 个压缩分片
          </strong>
          将同时删除，此操作不可撤销。
        </DialogDescription>
        <p
          v-if="logger.cloudError"
          role="alert"
          class="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive"
        >
          {{ logger.cloudError }}
        </p>
        <div class="mt-6 flex justify-end gap-2">
          <Button variant="outline" @click="logger.cancelDeleteCloudSnapshot()">取消</Button>
          <Button
            variant="destructive"
            :aria-busy="logger.isDeletingCloudSnapshot"
            @click="logger.confirmDeleteCloudSnapshot()"
          >
            {{ logger.isDeletingCloudSnapshot ? '正在删除…' : '确认删除' }}
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
