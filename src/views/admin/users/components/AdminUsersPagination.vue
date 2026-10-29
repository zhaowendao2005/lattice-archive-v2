<script setup lang="ts">
import { ChevronLeft, ChevronRight } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useAdminUsersStore } from '@/stores/admin/stores/adminUsersStore';
const store = useAdminUsersStore();
const changePageSize = (event: Event) => store.setPageSize(Number((event.target as HTMLSelectElement).value));
</script>

<template>
  <div class="flex flex-col gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
    <div class="flex items-center gap-2">
      <span>共 {{ store.total }} 位普通用户</span>
      <label for="users-page-size" class="ml-2">每页</label>
      <select id="users-page-size" :value="store.pageSize" class="h-8 rounded-md border border-input bg-card px-2 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring" @change="changePageSize">
        <option :value="20">20</option><option :value="50">50</option><option :value="100">100</option>
      </select>
      <span>条</span>
    </div>
    <div class="flex items-center gap-2">
      <Button variant="outline" size="sm" :disabled="store.page <= 1 || store.isLoading" aria-label="上一页" @click="store.setPage(store.page - 1)"><ChevronLeft class="size-4" />上一页</Button>
      <span class="min-w-20 text-center">第 {{ store.page }} / {{ store.totalPages }} 页</span>
      <Button variant="outline" size="sm" :disabled="store.page >= store.totalPages || store.isLoading" aria-label="下一页" @click="store.setPage(store.page + 1)">下一页<ChevronRight class="size-4" /></Button>
    </div>
  </div>
</template>
