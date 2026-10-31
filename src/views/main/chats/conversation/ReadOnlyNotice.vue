<!--
  底部操作条：
  · 未加入的公开群/频道 → 展示「加入 / 申请加入」按钮（区分需审核的 joinRequest）；
  · 已加入 → 提示“只读浏览”（本项目不做发送，因此不提供输入框）。
  提示优先级：actionError > joinNotice > 只读说明。
-->
<script setup lang="ts">
import { Clock, Eye, Loader2, UserPlus } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <!-- 底部栏：未加入的公开频道 / 群组提供加入入口；已加入会话保持只读提示 -->
  <div class="shrink-0 border-t border-border px-5 py-2.5 space-y-1.5">
    <p v-if="chatStore.actionError" class="mx-auto max-w-3xl text-center text-xs text-destructive" role="alert">
      {{ chatStore.actionError }}
    </p>
    <p v-else-if="chatStore.callbackNotice || chatStore.joinNotice" class="mx-auto max-w-3xl text-center text-xs text-brand" role="status">
      {{ chatStore.callbackNotice ?? chatStore.joinNotice }}
    </p>

    <div v-if="chatStore.activeHeader?.canJoin" class="mx-auto flex max-w-3xl items-center justify-between gap-3">
      <p class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <Clock v-if="chatStore.activeHeader.joinPending" class="size-3.5 shrink-0 text-brand" :stroke-width="1.75" />
        <Eye v-else class="size-3.5 shrink-0" :stroke-width="1.75" />
        <span class="truncate">
          {{ chatStore.activeHeader.joinPending ? '已提交加入申请，等待管理员审核' : '您尚未加入此公开会话，目前正在预览公开历史' }}
        </span>
      </p>
      <Button
        v-if="!chatStore.activeHeader.joinPending"
        size="sm"
        class="shrink-0 gap-1.5"
        @click="chatStore.joinActiveChat()"
      >
        <Loader2 v-if="chatStore.isJoining" class="size-3.5 animate-spin" :stroke-width="1.75" />
        <UserPlus v-else class="size-3.5" :stroke-width="1.75" />
        <span>{{ chatStore. isJoining ? '正在提交…' : chatStore.activeHeader.joinRequest ? '申请加入' : '加入会话' }}</span>
      </Button>
    </div>

    <p v-else class="mx-auto flex max-w-3xl items-center justify-center gap-2 text-xs text-muted-foreground">
      <Eye class="size-3.5 shrink-0" :stroke-width="1.75" />
      <span>只读浏览：消息与已读状态不会被修改</span>
    </p>
  </div>
</template>
