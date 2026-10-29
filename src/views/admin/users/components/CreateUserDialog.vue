<script setup lang="ts">
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAdminUsersStore } from '@/stores/admin/stores/adminUsersStore';
const store = useAdminUsersStore();
</script>

<template>
  <DialogRoot :open="store.isCreateOpen" @update:open="(open) => { if (!open) store.closeCreate(); }">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" />
      <DialogContent class="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl" @escape-key-down="(event) => { if (store.isSaving) event.preventDefault(); }" @interact-outside="(event) => { if (store.isSaving) event.preventDefault(); }">
        <DialogTitle class="text-lg font-semibold">新增用户</DialogTitle>
        <DialogDescription class="mt-1 text-sm text-muted-foreground">仅创建普通用户，不会切换当前管理员会话。</DialogDescription>
        <form class="mt-6 space-y-4" @submit.prevent="store.create()">
          <div><label for="create-user-name" class="mb-2 block text-sm font-medium">用户名</label><Input id="create-user-name" :model-value="store.nameInput" required maxlength="80" autocomplete="off" class="h-10" @update:model-value="store.setNameInput(String($event))" /></div>
          <div><label for="create-user-email" class="mb-2 block text-sm font-medium">邮箱</label><Input id="create-user-email" :model-value="store.emailInput" type="email" required maxlength="254" autocomplete="off" class="h-10" @update:model-value="store.setEmailInput(String($event))" /></div>
          <div><label for="create-user-password" class="mb-2 block text-sm font-medium">初始密码</label><Input id="create-user-password" :model-value="store.passwordInput" type="password" required minlength="8" maxlength="256" autocomplete="new-password" placeholder="8 至 256 位" class="h-10" @update:model-value="store.setPasswordInput(String($event))" /></div>
          <p v-if="store.formError" role="alert" class="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{{ store.formError }}</p>
          <div class="flex justify-end gap-2 pt-2"><Button type="button" variant="outline" @click="store.closeCreate()">取消</Button><Button type="submit" :aria-busy="store.isSaving">{{ store.isSaving ? '正在创建…' : '创建用户' }}</Button></div>
        </form>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
