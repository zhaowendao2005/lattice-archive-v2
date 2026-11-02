<script setup lang="ts">
/**
 * [VIEW] 全局任务与自适应配额状态 HUD 浮窗
 * 严格遵循零本地 ref / reactive 约束。
 */
import { Activity, CheckCircle2, ChevronDown, ChevronUp, Loader2, ShieldAlert, XCircle } from '@lucide/vue';
import { useSessionManagerStore } from '@/stores/archive/stores/sessionManagerStore';

const sessionStore = useSessionManagerStore();
</script>

<template>
  <div
    v-if="sessionStore.tasks.length > 0"
    class="fixed bottom-5 right-5 z-40 w-80 overflow-hidden rounded-2xl border border-border bg-popover text-popover-foreground shadow-xl transition-all"
  >
    <!-- 顶部折叠栏 -->
    <div
      class="flex cursor-pointer items-center justify-between gap-2 bg-muted/50 px-3.5 py-2.5 text-xs"
      @click="sessionStore.toggleHudExpanded()"
    >
      <div class="flex items-center gap-2">
        <Loader2
          v-if="sessionStore.activeTasks.length > 0"
          class="size-3.5 animate-spin text-primary"
        />
        <Activity v-else class="size-3.5 text-muted-foreground" />
        <span class="font-semibold text-foreground">
          {{
            sessionStore.activeTasks.length > 0
              ? `正在执行 ${sessionStore.activeTasks.length} 项后台任务`
              : `后台任务队列 (${sessionStore.tasks.length})`
          }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          v-if="sessionStore.activeTasks.length === 0"
          type="button"
          class="text-[11px] text-muted-foreground hover:text-foreground"
          @click.stop="sessionStore.clearCompletedTasks()"
        >
          清空
        </button>
        <component
          :is="sessionStore.isHudExpanded ? ChevronDown : ChevronUp"
          class="size-4 text-muted-foreground"
        />
      </div>
    </div>

    <!-- 任务明细列表 -->
    <div v-if="sessionStore.isHudExpanded" class="max-h-60 divide-y divide-border overflow-y-auto p-2.5 text-xs">
      <div
        v-for="task in sessionStore.tasks.slice(0, 12)"
        :key="task.id"
        class="py-2 first:pt-0 last:pb-0 space-y-1.5"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-1.5">
            <Loader2 v-if="task.status === 'running'" class="size-3.5 shrink-0 animate-spin text-primary" />
            <ShieldAlert v-else-if="task.status === 'paused'" class="size-3.5 shrink-0 text-destructive" />
            <CheckCircle2 v-else-if="task.status === 'completed'" class="size-3.5 shrink-0 text-primary" />
            <XCircle v-else class="size-3.5 shrink-0 text-destructive" />
            <span class="truncate font-medium text-foreground">{{ task.title }}</span>
          </div>
          <span class="shrink-0 tabular-nums text-[10px] text-muted-foreground">
            {{ task.progressCurrent }} / {{ task.progressTotal }}
          </span>
        </div>

        <div class="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            class="h-full rounded-full bg-primary transition-all"
            :style="{ width: `${Math.min(100, (task.progressCurrent / Math.max(1, task.progressTotal)) * 100)}%` }"
          />
        </div>

        <p v-if="task.errorMessage" class="text-[10px] text-destructive">
          {{ task.errorMessage }}
        </p>
      </div>
    </div>
  </div>
</template>
