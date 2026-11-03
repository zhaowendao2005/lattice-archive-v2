<script setup lang="ts">
/**
 * [VIEW] 搜索机器人内联键盘底部 [startPage, endPage] 自动翻页收割控制条
 * 严格遵循零本地 ref / reactive 约束。
 */
import { Bot, Eye, Loader2, Play, Square } from '@lucide/vue';
import { watch } from 'vue';
import { useBotHarvesterStore } from '@/stores/chat/stores/botHarvesterStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { TgInlineButton } from '@/stores/chat/types';

const props = defineProps<{
  messageId: number;
  rows: TgInlineButton[][];
}>();

const harvesterStore = useBotHarvesterStore();
const chatStore = useChatStore();

// 机器人分页元数据交由 Worker 解析；视图只读取 Store 缓存。
watch(
  () => {
    const messages = chatStore.activeWindow?.messages ?? [];
    const message = messages.find((item) => item.id === props.messageId);
    const query = chatStore.activeChatKey ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey] : '';
    return [props.messageId, props.rows, chatStore.accountId, message?.text, message?.replyMarkup, messages, query];
  },
  () => {
    const accountId = chatStore.accountId;
    const message = chatStore.activeWindow?.messages.find((item) => item.id === props.messageId);
    if (!accountId || !message) return;
    void harvesterStore.refreshMessageMetadata(
      accountId,
      message,
      chatStore.activeWindow?.messages ?? [],
      chatStore.activeChatKey ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey] : undefined,
    );
  },
  { immediate: true },
);
</script>

<template>
  <div
    v-if="harvesterStore.hasPaginationControls(props.rows, props.messageId)"
    class="mt-1 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-primary/30 bg-primary/5 px-3 py-1.5 text-xs"
  >
    <div class="flex flex-wrap items-center gap-2">
      <Bot class="size-3.5 shrink-0 text-primary" />
      <span class="font-semibold text-foreground">翻页收割：</span>
      <span
        class="max-w-36 truncate rounded bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
        :title="`关联查询词：${harvesterStore.getPairedQuery(props.messageId).queryText}`"
      >
        {{ harvesterStore.getPairedQuery(props.messageId).queryText }}
      </span>
      <label class="flex items-center gap-1 text-muted-foreground">
        <span>第</span>
        <input
          type="number"
          min="1"
          max="50"
          :value="harvesterStore.getStartPage(props.messageId)"
          class="h-6 w-12 rounded border border-border bg-background px-1.5 text-center text-xs font-semibold text-foreground tabular-nums"
          @change="harvesterStore.setStartPage(props.messageId, Number(($event.target as HTMLInputElement).value))"
        />
        <span>~</span>
        <input
          type="number"
          min="1"
          max="50"
          :value="harvesterStore.getEndPage(props.messageId)"
          class="h-6 w-12 rounded border border-border bg-background px-1.5 text-center text-xs font-semibold text-foreground tabular-nums"
          @change="harvesterStore.setEndPage(props.messageId, Number(($event.target as HTMLInputElement).value))"
        />
        <span>页</span>
      </label>
    </div>

    <div class="flex items-center gap-1.5">
      <button
        v-if="harvesterStore.activeTask?.messageId === props.messageId && harvesterStore.activeTask?.status === 'running'"
        type="button"
        class="flex items-center gap-1 rounded-lg bg-destructive px-2.5 py-1 text-[11px] font-semibold text-destructive-foreground"
        @click="harvesterStore.stopHarvest()"
      >
        <Loader2 class="size-3 animate-spin" />
        <span>停止 ({{ harvesterStore.activeTask.currentPage }}/{{ harvesterStore.activeTask.endPage }})</span>
        <Square class="size-2.5" />
      </button>

      <button
        v-else
        type="button"
        class="flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-transform active:scale-95"
        @click="harvesterStore.startHarvestRange(props.messageId)"
      >
        <Play class="size-3" />
        <span>自动翻页收割</span>
      </button>

      <button
        v-if="harvesterStore.candidates.length > 0"
        type="button"
        class="flex items-center gap-1 rounded-lg border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground hover:bg-accent"
        @click="harvesterStore.openCandidateModal()"
      >
        <Eye class="size-3 text-primary" />
        <span>收割池 ({{ harvesterStore.candidates.length }})</span>
      </button>
    </div>
  </div>
</template>
