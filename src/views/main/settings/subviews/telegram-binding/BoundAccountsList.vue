<script setup lang="ts">
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';
import type { TelegramAccount, TelegramAuthorization } from '@/stores/telegram/data-sources/tgRemoteDataSource';

const store = useTelegramStore();

function label(account: TelegramAccount) {
  return [account.first_name, account.last_name].filter(Boolean).join(' ') || account.username || '未命名账户';
}

function isCurrentDevice(authorization: TelegramAuthorization) {
  return authorization.device_id === store.deviceId;
}

function isOnline(authorization: TelegramAuthorization) {
  return store.onlineAuthorizations.some((item) => item.id === authorization.id);
}

function statusLabel(account: TelegramAccount, authorization: TelegramAuthorization) {
  if (authorization.session_state === 'revoked') return '已撤销';
  if (authorization.session_state === 'expired') return '已过期';
  if (authorization.session_state === 'duplicated') return '授权冲突';
  if (isOnline(authorization)) return '在线';
  if (isCurrentDevice(authorization) && store.connectionStates[account.tg_user_id] === 'connecting') return '连接中';
  if (isCurrentDevice(authorization) && store.connectionStates[account.tg_user_id] === 'reconnecting') return '正在重连';
  if (isCurrentDevice(authorization) && store.connectionStates[account.tg_user_id] === 'auth-expired') return '授权已失效';
  return '离线';
}

function canReconnect(account: TelegramAccount, authorization: TelegramAuthorization) {
  if (!isCurrentDevice(authorization) || authorization.session_state !== 'active') return false;
  const state = store.connectionStates[account.tg_user_id];
  return state === 'offline' || state === 'error';
}

function lastSeen(timestamp: number) {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}
</script>

<template>
  <section class="space-y-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h3 class="text-sm font-medium">已绑定账户</h3>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ store.accounts.length }} / 5 个账户 · {{ store.onlineAuthorizations.length }} 台设备在线
        </p>
      </div>
      <button type="button" class="token-control-height rounded-lg border border-border px-3 text-sm hover:bg-muted" @click="store.openLogin()">
        添加账户
      </button>
    </header>

    <div v-if="!store.accounts.length" class="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
      尚未绑定 Telegram 账户。添加账户后，可在其他设备上为同一账户添加独立授权。
    </div>

    <div v-else class="space-y-4">
      <article v-for="account in store.accounts" :key="account.id" class="overflow-hidden rounded-xl border border-border bg-card">
        <header class="flex items-start justify-between gap-4 px-4 py-4 sm:px-5">
          <div class="min-w-0">
            <h4 class="truncate text-sm font-medium">{{ label(account) }}</h4>
            <p class="mt-1 break-all text-xs text-muted-foreground">
              Telegram ID：{{ account.tg_user_id }}<span v-if="account.phone_mask"> · {{ account.phone_mask }}</span>
            </p>
          </div>
          <button type="button" class="shrink-0 text-xs text-destructive hover:underline" @click="store.removeAccount(account.id)">
            解绑账户
          </button>
        </header>

        <div class="border-t border-border bg-muted/30 px-4 py-3 sm:px-5">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p class="text-xs font-medium text-foreground">设备</p>
              <p class="mt-1 text-[11px] text-muted-foreground">{{ account.authorizations.length }} / 3 台设备 · 每台设备独立授权，同一设备的标签页共用一条连接。</p>
            </div>
            <button
              v-if="!account.authorizations.some((item) => item.device_id === store.deviceId)"
              type="button"
              class="token-control-height rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90"
              @click="store.openDeviceLogin(account.tg_user_id)"
            >
              添加设备
            </button>
            <span v-else class="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">本设备已添加</span>
          </div>

          <div v-if="account.authorizations.length" class="divide-y divide-border rounded-lg border border-border bg-card">
            <div v-for="authorization in account.authorizations" :key="authorization.id" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-3 py-3">
              <div class="flex min-w-0 items-center gap-3">
                <span class="size-2 shrink-0 rounded-full" :class="isOnline(authorization) ? 'bg-primary' : 'bg-muted-foreground/40'"></span>
                <div class="min-w-0">
                  <p class="truncate text-xs font-medium text-foreground">
                    {{ authorization.device_label }}
                    <span v-if="isCurrentDevice(authorization)" class="ml-1 font-normal text-muted-foreground">· 本设备</span>
                  </p>
                  <p class="mt-1 text-[11px] text-muted-foreground">
                    {{ authorization.platform }} · 最近活动 {{ lastSeen(authorization.last_seen_at) }}
                  </p>
                  <p
                    v-if="isCurrentDevice(authorization) && store.connectionNotices[account.tg_user_id]"
                    class="mt-1 text-[11px]"
                    :class="store.connectionStates[account.tg_user_id] === 'auth-expired' ? 'text-destructive' : 'text-muted-foreground'"
                  >
                    {{ store.connectionNotices[account.tg_user_id] }}
                  </p>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-3">
                <span class="text-xs" :class="isOnline(authorization) ? 'text-primary' : 'text-muted-foreground'">
                  {{ statusLabel(account, authorization) }}
                </span>
                <button
                  v-if="canReconnect(account, authorization)"
                  type="button"
                  class="min-h-8 text-xs text-primary hover:underline"
                  @click="store.reconnectAccount(account.tg_user_id)"
                >
                  重新连接
                </button>
                <button type="button" class="min-h-8 text-xs text-destructive hover:underline" @click="store.removeAuthorization(authorization.id)">
                  移除
                </button>
              </div>
            </div>
          </div>
          <p v-else class="rounded-lg border border-dashed border-border bg-card px-3 py-4 text-center text-xs text-muted-foreground">
            暂无设备授权
          </p>
        </div>
      </article>
    </div>
  </section>
</template>
