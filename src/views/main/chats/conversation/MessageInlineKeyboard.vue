<!--
  消息底部内联按键矩阵（ReplyInlineMarkup，纯表现层，零本地 ref）：
  · 按行（rows）等宽排布在气泡正下方；
  · 支持 Callback 回调翻页/筛选（带旋转加载指示）、URL 跳转角标、复制文本与内联查询。
-->
<script setup lang="ts">
import { ArrowUpRight, Copy, Loader2 } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { TgInlineButton } from '@/stores/chat/types';

const props = defineProps<{
  messageId: number;
  rows: TgInlineButton[][];
}>();

const chatStore = useChatStore();
</script>

<template>
  <div class="flex w-full flex-col gap-1 pt-0.5">
    <div
      v-for="(row, rowIdx) in props.rows"
      :key="rowIdx"
      class="flex w-full items-stretch gap-1"
    >
      <button
        v-for="(btn, colIdx) in row"
        :key="colIdx"
        type="button"
        class="relative flex min-h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border border-border/75 bg-muted/90 px-2 py-1.5 text-center text-xs font-medium text-foreground transition-colors hover:bg-accent"
        :title="btn.url || btn.text"
        @click="chatStore.pressInlineButton(props.messageId, rowIdx, colIdx, btn)"
      >
        <Loader2
          v-if="chatStore.isCallbackPending(props.messageId, rowIdx, colIdx)"
          class="size-3.5 shrink-0 animate-spin text-brand"
          :stroke-width="2"
        />
        <span class="truncate">{{ btn.text }}</span>
        <ArrowUpRight
          v-if="btn.kind === 'url' || btn.kind === 'webview'"
          class="absolute top-1 right-1 size-2.5 text-muted-foreground"
          :stroke-width="2"
        />
        <Copy
          v-else-if="btn.kind === 'copy'"
          class="size-3 shrink-0 text-muted-foreground"
          :stroke-width="1.75"
        />
      </button>
    </div>
  </div>
</template>
