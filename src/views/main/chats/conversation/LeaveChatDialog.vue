<!--
  退出群/频道确认弹窗。
  特别注意“创建者”分支：直接退出会丢失管理权，因此只给出说明，不提供确认按钮。
  遮罩用 bg-media-backdrop（深色沉浸令牌），避免暗色模式下发白。
-->
<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { AlertTriangle, Loader2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <DialogRoot
    :open="chatStore.leaveTargetDialog !== null"
    @update:open="(open) => { if (!open) chatStore.cancelLeaveChat(); }"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-media-backdrop" />
      <DialogContent
        v-if="chatStore.leaveTargetDialog"
        class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-xl outline-none"
      >
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <AlertTriangle class="size-4" :stroke-width="1.75" />
          </span>
          <div class="min-w-0 flex-1 space-y-1.5">
            <DialogTitle class="text-sm font-semibold">
              {{ chatStore.leaveTargetDialog.isCreator ? '无法直接退出' : `退出${chatStore.leaveTargetDialog.kindLabel}` }}
            </DialogTitle>
            <DialogDescription class="text-xs leading-relaxed text-muted-foreground">
              <template v-if="chatStore.leaveTargetDialog.isCreator">
                您是「{{ chatStore.leaveTargetDialog.title }}」的创建者，直接退出会导致管理权丢失。请先在 Telegram 官方客户端转让所有权或解散该{{ chatStore.leaveTargetDialog.kindLabel }}。
              </template>
              <template v-else>
                确定要退出「{{ chatStore.leaveTargetDialog.title }}」吗？退出后该{{ chatStore.leaveTargetDialog.kindLabel }}将从会话列表中移除。
              </template>
            </DialogDescription>
          </div>
        </div>

        <p v-if="chatStore.leaveError" class="mt-3 text-xs text-destructive" role="alert">
          {{ chatStore.leaveError }}
        </p>

        <div class="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" @click="chatStore.cancelLeaveChat()">
            {{ chatStore.leaveTargetDialog.isCreator ? '我知道了' : '取消' }}
          </Button>
          <Button
            v-if="!chatStore.leaveTargetDialog.isCreator"
            variant="destructive"
            size="sm"
            class="gap-1.5"
            @click="chatStore.confirmLeaveChat()"
          >
            <Loader2 v-if="chatStore.isLeaving" class="size-3.5 animate-spin" :stroke-width="1.75" />
            <span>{{ chatStore.isLeaving ? '正在退出…' : '确认退出' }}</span>
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
