<script setup lang="ts">
import { DialogRoot, DialogPortal, DialogOverlay, DialogContent, DialogTitle, DialogDescription } from 'reka-ui';
import { Button } from '@/components/ui/button';
import { useAdminUsersStore } from '@/stores/admin/stores/adminUsersStore';
const store = useAdminUsersStore();
</script>

<template>
  <DialogRoot :open="!!store.deleteTarget" @update:open="(open) => { if (!open) store.closeDelete(); }">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-background/80 backdrop-blur-sm" />
      <DialogContent class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-card p-6 shadow-xl" @escape-key-down="(event) => { if (store.isDeleting) event.preventDefault(); }" @interact-outside="(event) => { if (store.isDeleting) event.preventDefault(); }">
        <DialogTitle class="text-lg font-semibold">删除用户</DialogTitle>
        <DialogDescription class="mt-2 text-sm leading-relaxed text-muted-foreground">确定删除 <strong class="font-semibold text-foreground">{{ store.deleteTarget?.email }}</strong>？该用户的远端会话也会同时失效，此操作不可撤销。</DialogDescription>
        <p v-if="store.deleteError" role="alert" class="mt-4 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{{ store.deleteError }}</p>
        <div class="mt-6 flex justify-end gap-2"><Button variant="outline" @click="store.closeDelete()">取消</Button><Button variant="destructive" :aria-busy="store.isDeleting" @click="store.remove()">{{ store.isDeleting ? '正在删除…' : '确认删除' }}</Button></div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
