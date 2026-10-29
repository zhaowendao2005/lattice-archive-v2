<script setup lang="ts">
import { RefreshCw, Search, UserPlus } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAdminUsersStore } from '@/stores/admin/stores/adminUsersStore';
const store = useAdminUsersStore();
</script>

<template>
  <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <form class="flex min-w-0 flex-1 gap-2" role="search" @submit.prevent="store.applySearch()">
      <Input
        :model-value="store.searchInput" type="search" maxlength="100" placeholder="搜索用户名或邮箱"
        aria-label="搜索用户" class="h-10 max-w-sm bg-card"
        @update:model-value="store.setSearchInput(String($event))"
      />
      <Button type="submit" variant="outline" class="h-10 px-3" aria-label="执行搜索">
        <Search class="size-4" /><span class="hidden sm:inline">搜索</span>
      </Button>
    </form>
    <div class="flex gap-2">
      <Button variant="outline" class="h-10" aria-label="刷新用户列表" @click="store.load()">
        <RefreshCw class="size-4" :class="store.isLoading ? 'animate-spin' : ''" />刷新
      </Button>
      <Button class="h-10" @click="store.openCreate()"><UserPlus class="size-4" />新增用户</Button>
    </div>
  </div>
</template>
