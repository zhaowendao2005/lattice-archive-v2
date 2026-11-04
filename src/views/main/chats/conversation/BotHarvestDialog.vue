<script setup lang="ts">
/**
 * [VIEW] 「解析消息」设置弹窗：由消息右侧工具条的解析按钮打开。
 * 页码区间与自动翻页收割流程沿用 botHarvesterStore.startHarvestRange；完成后自动打开候选池弹窗。
 * 严格遵循零本地 ref / reactive 约束。
 */
import { Bot, Eye, Loader2, Play, Square, X } from '@lucide/vue';
import { useBotHarvesterStore } from '@/stores/chat/stores/botHarvesterStore';

const harvesterStore = useBotHarvesterStore();
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div
        v-if="harvesterStore.dialogMessageId !== null"
        class="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-md p-4"
        @click.self="harvesterStore.closeHarvestDialog()"
        @keydown.esc="harvesterStore.closeHarvestDialog()"
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="解析消息"
          class="w-full max-w-md overflow-hidden rounded-3xl border border-border bg-card text-card-foreground shadow-2xl"
        >
          <header class="flex items-center justify-between border-b border-border bg-muted/30 px-5 py-4">
            <div class="flex items-center gap-3">
              <div class="flex size-9 items-center justify-center rounded-2xl bg-primary/15 text-primary">
                <Bot class="size-5" />
              </div>
              <div>
                <h2 class="text-base font-bold text-foreground">解析消息</h2>
                <p class="text-xs text-muted-foreground">提取消息中的群 / 频道链接，可自动翻页</p>
              </div>
            </div>
            <button
              type="button"
              class="rounded-full p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="关闭"
              @click="harvesterStore.closeHarvestDialog()"
            >
              <X class="size-5" />
            </button>
          </header>

          <div class="space-y-4 px-5 py-4 text-xs">
            <div class="flex items-center gap-2 text-muted-foreground">
              <span>关联查询词：</span>
              <span class="max-w-60 truncate rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary">
                {{ harvesterStore.getPairedQuery(harvesterStore.dialogMessageId).queryText }}
              </span>
            </div>

            <div v-if="harvesterStore.hasPaginationControls([], harvesterStore.dialogMessageId)" class="flex items-center gap-2 text-muted-foreground">
              <span>自动翻页：第</span>
              <input
                type="number"
                min="1"
                max="50"
                :value="harvesterStore.getStartPage(harvesterStore.dialogMessageId)"
                class="h-7 w-14 rounded border border-border bg-background px-1.5 text-center text-xs font-semibold text-foreground tabular-nums"
                @change="harvesterStore.setStartPage(harvesterStore.dialogMessageId, Number(($event.target as HTMLInputElement).value))"
              />
              <span>~</span>
              <input
                type="number"
                min="1"
                max="50"
                :value="harvesterStore.getEndPage(harvesterStore.dialogMessageId)"
                class="h-7 w-14 rounded border border-border bg-background px-1.5 text-center text-xs font-semibold text-foreground tabular-nums"
                @change="harvesterStore.setEndPage(harvesterStore.dialogMessageId, Number(($event.target as HTMLInputElement).value))"
              />
              <span>页</span>
            </div>
            <p v-else class="text-muted-foreground">该消息没有翻页按钮，将只解析当前消息。</p>

            <p
              v-if="harvesterStore.activeTask?.messageId === harvesterStore.dialogMessageId && harvesterStore.activeTask.errorMessage"
              class="font-medium text-destructive"
            >
              {{ harvesterStore.activeTask.errorMessage }}
            </p>

            <div class="flex items-center justify-between gap-2 pt-1">
              <button
                v-if="harvesterStore.candidates.length > 0"
                type="button"
                class="flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 font-medium text-foreground hover:bg-accent"
                @click="harvesterStore.openCandidateModal()"
              >
                <Eye class="size-3.5 text-primary" />
                <span>收割池 ({{ harvesterStore.candidates.length }})</span>
              </button>
              <span v-else />

              <button
                v-if="harvesterStore.activeTask?.messageId === harvesterStore.dialogMessageId && harvesterStore.activeTask?.status === 'running'"
                type="button"
                class="flex items-center gap-1.5 rounded-xl bg-destructive px-4 py-1.5 font-semibold text-destructive-foreground"
                @click="harvesterStore.stopHarvest()"
              >
                <Loader2 class="size-3.5 animate-spin" />
                <span>停止 ({{ harvesterStore.activeTask.currentPage }}/{{ harvesterStore.activeTask.endPage }})</span>
                <Square class="size-3" />
              </button>
              <button
                v-else
                type="button"
                class="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-1.5 font-semibold text-primary-foreground transition-transform active:scale-95"
                @click="harvesterStore.startHarvestRange(harvesterStore.dialogMessageId)"
              >
                <Play class="size-3.5" />
                <span>开始解析</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
