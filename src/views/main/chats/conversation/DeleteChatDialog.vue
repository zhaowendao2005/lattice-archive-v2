<!--
  删除会话确认弹窗。
  针对用户间私聊（用户/机器人）：支持勾选「同时为对方删除」（revoke: true）。
  针对群组或频道：转为退出/移除确认。
  严格零本地 ref / reactive，所有状态托管在 chatStore。
-->
<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { Loader2, Trash2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <DialogRoot
    :open="chatStore.deleteTargetDialog !== null"
    @update:open="(open) => { if (!open) chatStore.cancelDeleteChat(); }"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-media-backdrop" />
      <DialogContent
        v-if="chatStore.deleteTargetDialog"
        class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-xl outline-none"
      >
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <Trash2 class="size-4" :stroke-width="1.75" />
          </span>
          <div class="min-w-0 flex-1 space-y-1.5">
            <DialogTitle class="text-sm font-semibold">
              删除与「{{ chatStore.deleteTargetDialog.title }}」的聊天
            </DialogTitle>
            <DialogDescription class="text-xs leading-relaxed text-muted-foreground">
              确定要删除此会话的全部聊天记录吗？此操作无法撤销。
            </DialogDescription>
          </div>
        </div>

        <!-- 针对用户间聊天：允许勾选同时为对方删除（默认开启） -->
        <div v-if="chatStore.deleteTargetDialog.isUser" class="mt-4 pt-1">
          <label class="flex items-center gap-2.5 text-xs text-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              :checked="chatStore.deleteRevokeForBoth"
              class="size-4 rounded border-border text-brand focus:ring-brand accent-brand cursor-pointer"
              @change="chatStore.toggleDeleteRevoke()"
            />
            <span>同时为「{{ chatStore.deleteTargetDialog.title }}」删除</span>
          </label>
        </div>

        <p v-if="chatStore.deleteChatError" class="mt-3 text-xs text-destructive" role="alert">
          {{ chatStore.deleteChatError }}
        </p>

        <div class="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" @click="chatStore.cancelDeleteChat()">
            取消
          </Button>
          <Button
            variant="destructive"
            size="sm"
            class="gap-1.5"
            @click="chatStore.confirmDeleteChat()"
          >
            <Loader2 v-if="chatStore.isDeletingChat" class="size-3.5 animate-spin" :stroke-width="1.75" />
            <span>{{ chatStore.isDeletingChat ? '正在删除…' : '删除聊天' }}</span>
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
