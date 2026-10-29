<script setup lang="ts">
import { ArrowRight, KeyRound, ShieldCheck, UsersRound } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/stores/auth/stores/authStore';
const auth = useAuthStore();
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8">
    <header><h1 class="text-xl font-semibold tracking-tight">系统概览</h1><p class="mt-1 text-sm text-muted-foreground">管理员会话与账户管理能力</p></header>
    <section class="grid gap-4 sm:grid-cols-2">
      <article class="rounded-xl border border-border bg-card p-5"><ShieldCheck class="size-5 text-brand" /><h2 class="mt-4 font-medium">管理员身份已验证</h2><p class="mt-2 break-all text-sm text-muted-foreground">{{ auth.user?.email }}</p></article>
      <article class="rounded-xl border border-border bg-card p-5"><KeyRound class="size-5 text-brand" /><h2 class="mt-4 font-medium">服务端权限校验</h2><p class="mt-2 text-sm text-muted-foreground">所有管理接口逐次验证 D1 会话及角色。</p></article>
    </section>
    <section class="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-3"><UsersRound class="size-5 text-brand" /><div><h2 class="font-medium">用户管理</h2><p class="mt-1 text-sm text-muted-foreground">搜索、新增或删除普通用户账户。</p></div></div>
      <RouterLink :to="{ name: 'admin-users' }"><Button>进入用户管理<ArrowRight class="size-4" /></Button></RouterLink>
    </section>
  </div>
</template>
