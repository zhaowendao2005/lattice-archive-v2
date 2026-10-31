<script setup lang="ts">
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';
const store = useTelegramStore();
function label(account: { first_name: string | null; last_name: string | null; username: string | null }) { return [account.first_name, account.last_name].filter(Boolean).join(' ') || account.username || '未命名账户'; }
</script>

<template>
  <section class="space-y-3">
    <div class="flex items-center justify-between gap-3"><div><h3 class="text-sm font-medium">已绑定账户</h3><p class="mt-1 text-xs text-muted-foreground">{{ store.accounts.length }} / 5 个账户，{{ store.activeAuthorizations.length }} 台设备在线</p></div><button type="button" class="token-control-height rounded-lg border border-border px-3 text-sm hover:bg-muted" @click="store.openLogin()">添加账户</button></div>
    <div v-if="!store.accounts.length" class="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">尚未绑定 Telegram 账户。添加账户时，每台设备都会创建独立授权。</div>
    <div v-else class="space-y-3"><article v-for="account in store.accounts" :key="account.id" class="rounded-xl border border-border bg-card p-4"><div class="flex items-start justify-between gap-3"><div><h4 class="text-sm font-medium">{{ label(account) }}</h4><p class="mt-1 text-xs text-muted-foreground">Telegram ID：{{ account.tg_user_id }}<span v-if="account.phone_mask"> · {{ account.phone_mask }}</span></p></div><button type="button" class="text-xs text-destructive hover:underline" @click="store.removeAccount(account.id)">解绑</button></div><div class="mt-4 space-y-2"><div v-for="authorization in account.authorizations" :key="authorization.id" class="flex items-center justify-between gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs"><span><span class="font-medium">{{ authorization.device_label }}</span><span class="ml-2 text-muted-foreground">{{ authorization.platform }}</span></span><button type="button" class="text-destructive hover:underline" @click="store.removeAuthorization(authorization.id)">移除设备</button></div><p v-if="!account.authorizations.length" class="text-xs text-muted-foreground">暂无设备授权记录</p></div></article></div>
  </section>
</template>
