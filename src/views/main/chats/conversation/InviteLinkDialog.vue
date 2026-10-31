<!--
  私有邀请链接（t.me/+hash）预览与加入确认弹窗（纯表现层，零本地 ref）。
  主按钮不置灰，加载态与错误提示均在 chatStore 中管理。
-->
<script setup lang="ts">
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { Loader2, UserPlus, Users } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const chatStore = useChatStore();
</script>

<template>
  <DialogRoot
    :open="chatStore.invitePreview !== null"
    @update:open="(open) => { if (!open) chatStore.closeInviteDialog(); }"
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-media-backdrop" />
      <DialogContent
        v-if="chatStore.invitePreview"
        class="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-5 text-foreground shadow-xl outline-none"
      >
        <div class="flex items-start gap-3">
          <span class="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
            <Users class="size-5" :stroke-width="1.75" />
          </span>
          <div class="min-w-0 flex-1 space-y-1">
            <DialogTitle class="truncate text-sm font-semibold">
              {{ chatStore.invitePreview.title }}
            </DialogTitle>
            <DialogDescription class="text-xs text-muted-foreground">
              {{ chatStore.invitePreview.isChannel ? '私有频道 / 超级群组' : '私有群组' }}
              <template v-if="chatStore.invitePreview.participantsCount">
                · {{ chatStore.invitePreview.participantsCount.toLocaleString('zh-CN') }} 位成员
              </template>
            </DialogDescription>
            <p v-if="chatStore.invitePreview.about" class="line-clamp-3 pt-1 text-xs leading-relaxed text-foreground">
              {{ chatStore.invitePreview.about }}
            </p>
          </div>
        </div>

        <p v-if="chatStore.inviteError" class="mt-3 text-xs text-destructive" role="alert">
          {{ chatStore.inviteError }}
        </p>

        <div class="mt-5 flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" @click="chatStore.closeInviteDialog()">
            取消
          </Button>
          <Button size="sm" class="gap-1.5" @click="chatStore.confirmImportInvite()">
            <Loader2 v-if="chatStore.isImportingInvite" class="size-3.5 animate-spin" :stroke-width="1.75" />
            <UserPlus v-else class="size-3.5" :stroke-width="1.75" />
            <span>
              {{ chatStore.isImportingInvite ? '正在加入…' : chatStore.invitePreview.joinRequest ? '申请加入' : '加入会话' }}
            </span>
          </Button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
