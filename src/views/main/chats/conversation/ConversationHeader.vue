<!--
  ============================================================================
  会话头部（头像 / 标题 / 副标题 + 返回栈导航 + 归档/删除/退出 + 关闭会话）
  ============================================================================
  所有显示数据来自 chatStore.activeHeader 这个 getter。
  左侧返回按钮依照访问栈原则（chatStore.canGoBack）支持跨群组/频道回退；
  右侧支持针对私聊的删除聊天、群组频道的退出、以及关闭当前会话。
-->
<script setup lang="ts">
import { Archive, ArchiveRestore, ArrowLeft, ArrowRightFromLine, Loader2, LogOut, Trash2, X } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { vAvatarVisible } from './media/mediaVisible';

const chatStore = useChatStore();
const mediaStore = useChatMediaStore();
</script>

<template>
  <header class="h-14 shrink-0 flex items-center justify-between gap-3 px-4 border-b border-border bg-card/60 backdrop-blur-md">
    <div class="min-w-0 flex items-center gap-2">
      <!-- 侧栏抽屉展开按钮（当列表折叠时展示）：固定贴在最左侧，位置不随返回按钮的出现而跳动 -->
      <Button
        v-if="chatStore.isSessionListCollapsed"
        variant="ghost"
        size="icon"
        class="token-hit-target shrink-0 text-muted-foreground"
        aria-label="展开会话列表"
        title="展开会话列表"
        @click="chatStore.toggleSessionList()"
      >
        <ArrowRightFromLine :stroke-width="1.75" />
      </Button>

      <!-- 跨群组跳转返回栈（栈原则）：点击沿访问顺序返回上一会话 -->
      <Button
        v-if="chatStore.canGoBack"
        variant="ghost"
        size="icon"
        class="token-hit-target shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
        :aria-label="chatStore.previousChatTitle ? `返回：${chatStore.previousChatTitle}` : '返回上一会话'"
        :title="chatStore.previousChatTitle ? `返回：${chatStore.previousChatTitle}` : '返回上一会话'"
        @click="chatStore.goBackChat()"
      >
        <ArrowLeft class="size-4" :stroke-width="2" />
      </Button>

      <span
        v-if="chatStore.activeHeader"
        :key="chatStore.activeHeader.key"
        v-avatar-visible="chatStore.activeHeader.avatarKey ? chatStore.activeHeader.key : undefined"
        class="relative size-8 shrink-0 overflow-hidden rounded-full bg-brand-soft text-brand text-[11px] font-semibold flex items-center justify-center"
      >
        <img
          v-if="mediaStore.avatarUrl(chatStore.activeHeader.avatarKey, chatStore.activeHeader.avatarThumb)"
          :src="mediaStore.avatarUrl(chatStore.activeHeader.avatarKey, chatStore.activeHeader.avatarThumb)"
          :alt="chatStore.activeHeader.title"
          :class="[
            'size-full object-cover',
            !mediaStore.isAvatarLoaded(chatStore.activeHeader.avatarKey) && chatStore.activeHeader.avatarThumb ? 'scale-110 blur-[2px]' : ''
          ]"
          loading="lazy"
        />
        <span v-else>{{ chatStore.activeHeader.initials }}</span>
      </span>

      <div class="min-w-0">
        <h2 class="text-sm font-semibold truncate">{{ chatStore.activeHeader?.title ?? '会话' }}</h2>
        <p class="text-xs text-muted-foreground truncate">{{ chatStore.activeHeader?.subtitle ?? chatStore.syncStatus.label }}</p>
      </div>
    </div>

    <div v-if="chatStore.activeHeader" class="flex shrink-0 items-center gap-1">
      <!-- 归档 / 取消归档 -->
      <Button
        v-if="chatStore.activeHeader.canArchive"
        variant="ghost"
        size="icon"
        class="size-8 text-muted-foreground"
        :aria-label="chatStore.activeHeader.archived ? '取消归档' : '归档会话'"
        :title="chatStore.activeHeader.archived ? '取消归档' : '归档会话'"
        @click="chatStore.toggleArchive()"
      >
        <Loader2 v-if="chatStore.activeHeader.isArchiving" class="size-4 animate-spin" :stroke-width="1.75" />
        <ArchiveRestore v-else-if="chatStore.activeHeader.archived" class="size-4" :stroke-width="1.75" />
        <Archive v-else class="size-4" :stroke-width="1.75" />
      </Button>

      <!-- 删除聊天（针对用户间私聊，支持双向删除对方聊天） -->
      <Button
        v-if="chatStore.activeHeader.canDelete"
        variant="ghost"
        size="icon"
        class="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        aria-label="删除聊天"
        title="删除聊天"
        @click="chatStore.promptDeleteChat()"
      >
        <Trash2 class="size-4" :stroke-width="1.75" />
      </Button>

      <!-- 退出群组 / 频道 -->
      <Button
        v-if="chatStore.activeHeader.canLeave"
        variant="ghost"
        size="icon"
        class="size-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        aria-label="退出会话"
        title="退出会话"
        @click="chatStore.promptLeaveChat()"
      >
        <LogOut class="size-4" :stroke-width="1.75" />
      </Button>

      <!-- 关闭当前会话（清除右栏选中态，返回空态引导） -->
      <Button
        variant="ghost"
        size="icon"
        class="size-8 text-muted-foreground hover:text-foreground hover:bg-muted"
        aria-label="关闭会话"
        title="关闭当前会话"
        @click="chatStore.closeActiveChat()"
      >
        <X class="size-4" :stroke-width="1.75" />
      </Button>
    </div>
  </header>
</template>
