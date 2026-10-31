<!--
  会话底部消息输入栏（纯表现层，零本地 ref）：
  · 支持在搜索群（如极搜 @JISOU）、普通群组、机器人、私聊及收藏夹中输入文本并发送；
  · 支持展示当前选中的「回复目标」卡片；
  · 输入框 DOM 句柄统一交由 messageViewport.attachComposerInput 管理；
  · 主发送按钮始终可点（不置灰），空内容提交时聚焦输入框并提示中文错误。
-->
<script setup lang="ts">
import type { ComponentPublicInstance } from 'vue';
import { Loader2, Reply, Send, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { messageViewport } from '@/stores/chat/data-sources/messageViewport';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();

function attachInput(target: Element | ComponentPublicInstance | null) {
  messageViewport.attachComposerInput(target instanceof Element ? target : null);
}
</script>

<template>
  <div class="shrink-0 border-t border-border bg-card/85 px-5 py-2.5 backdrop-blur-xs">
    <div class="mx-auto max-w-3xl space-y-1.5">
      <p v-if="chatStore.actionError" class="text-center text-xs text-destructive" role="alert">
        {{ chatStore.actionError }}
      </p>
      <p v-else-if="chatStore.callbackNotice || chatStore.joinNotice" class="text-center text-xs text-brand" role="status">
        {{ chatStore.callbackNotice ?? chatStore.joinNotice }}
      </p>

      <!-- 待回复消息提示条 -->
      <div
        v-if="chatStore.activeReplyTarget"
        class="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted px-3 py-1.5 text-xs"
      >
        <div
          class="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
          @click="chatStore.activeChatKey && chatStore.focusMessageInChat(chatStore.activeChatKey, chatStore.activeReplyTarget.id)"
        >
          <Reply class="size-3.5 shrink-0 text-brand" :stroke-width="2" />
          <div class="min-w-0 flex-1 border-l-2 border-brand pl-2">
            <p class="truncate font-semibold text-brand">回复 {{ chatStore.activeReplyTarget.senderName }}</p>
            <p class="truncate text-muted-foreground">{{ chatStore.activeReplyTarget.text }}</p>
          </div>
        </div>
        <button
          type="button"
          class="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="取消回复"
          @click="chatStore.cancelReplyTarget()"
        >
          <X class="size-3.5" :stroke-width="1.75" />
        </button>
      </div>

      <!-- 输入框与主发送按钮 -->
      <form class="flex items-center gap-2" @submit.prevent="chatStore.sendActiveMessage()">
        <input
          :ref="attachInput"
          type="text"
          :value="chatStore.activeDraft"
          placeholder="输入消息或搜索关键词，按 Enter 发送…"
          class="h-10 min-w-0 flex-1 rounded-xl border border-border bg-muted px-3.5 text-foreground placeholder:text-muted-foreground focus:border-brand focus:bg-card focus:outline-none"
          @input="chatStore.setDraft(($event.target as HTMLInputElement).value)"
        />
        <Button type="submit" size="sm" class="h-10 shrink-0 gap-1.5 rounded-xl px-4">
          <Loader2 v-if="chatStore.isSendingMessage" class="size-4 animate-spin" :stroke-width="1.75" />
          <Send v-else class="size-4" :stroke-width="1.75" />
          <span>{{ chatStore.isSendingMessage ? '发送中' : '发送' }}</span>
        </Button>
      </form>
    </div>
  </div>
</template>
