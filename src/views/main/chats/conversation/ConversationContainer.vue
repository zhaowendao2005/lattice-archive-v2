<!--
  ============================================================================
  右栏：会话内容容器
  ============================================================================
  只负责“按选中状态拼装”，不持有任何数据：
  · 无选中会话 → 空态引导；
  · 有选中 → 头部 + 消息流 + 只读提示 + 媒体查看器（浮层）+ 退出确认弹窗。
-->
<script setup lang="ts">
import { MessagesSquare } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import ChatComposer from './ChatComposer.vue';
import ConversationHeader from './ConversationHeader.vue';
import DeleteChatDialog from './DeleteChatDialog.vue';
import InviteLinkDialog from './InviteLinkDialog.vue';
import LeaveChatDialog from './LeaveChatDialog.vue';
import MessageFeed from './MessageFeed.vue';
import ReadOnlyNotice from './ReadOnlyNotice.vue';
import MediaViewer from './media/MediaViewer.vue';

const chatStore = useChatStore();
</script>

<template>
  <section class="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
    <ConversationHeader />
    <template v-if="chatStore.activeChatKey">
      <!-- 消息流：消息窗口、日期分隔、气泡与媒体均在内部 -->
      <MessageFeed />
      <!-- 可发言会话（搜索群 / 机器人 / 私聊 / 普通群组）展示底部输入栏；只读频道与未加入会话展示底部提示条 -->
      <ChatComposer v-if="chatStore.canSendInActiveChat" />
      <ReadOnlyNotice v-else />
      <!-- 沉浸式查看器是浮层，挂在这里以便复用当前会话上下文 -->
      <MediaViewer />
    </template>
    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
      <MessagesSquare class="size-8" :stroke-width="1.5" />
      <p class="text-sm">从左侧选择一个会话开始浏览</p>
    </div>
    <LeaveChatDialog />
    <DeleteChatDialog />
    <InviteLinkDialog />
  </section>
</template>
