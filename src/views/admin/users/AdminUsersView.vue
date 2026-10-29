<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import { UsersRound } from '@lucide/vue';
import { useAdminUsersStore } from '@/stores/admin/stores/adminUsersStore';
import AdminUsersTable from './components/AdminUsersTable.vue';
import AdminUsersToolbar from './components/AdminUsersToolbar.vue';
import AdminUsersPagination from './components/AdminUsersPagination.vue';
import CreateUserDialog from './components/CreateUserDialog.vue';
import DeleteUserDialog from './components/DeleteUserDialog.vue';
const store = useAdminUsersStore();
onMounted(() => { void store.load(); });
onBeforeUnmount(() => store.dispose());
</script>

<template>
  <div class="mx-auto w-full max-w-7xl space-y-5 p-4 sm:p-6 lg:p-8">
    <header class="flex items-center gap-3">
      <span class="flex size-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"><UsersRound class="size-5" /></span>
      <div><h1 class="text-xl font-semibold tracking-tight">用户管理</h1><p class="mt-1 text-sm text-muted-foreground">管理普通用户账户及其远端访问权限</p></div>
    </header>

    <AdminUsersToolbar />
    <p v-if="store.notice" role="status" class="rounded-lg border border-border bg-brand-soft px-3 py-2 text-sm text-foreground">{{ store.notice }}</p>
    <div v-if="store.error" role="alert" class="flex items-center justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <span>{{ store.error }}</span><button type="button" class="shrink-0 font-medium underline underline-offset-4" @click="store.load()">重试</button>
    </div>

    <section aria-label="普通用户列表" class="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      <AdminUsersTable />
    </section>
    <AdminUsersPagination />
    <p class="text-xs leading-relaxed text-muted-foreground">删除操作仅影响远端账户和会话，不会清除用户设备上的本地归档。</p>
    <CreateUserDialog /><DeleteUserDialog />
  </div>
</template>
