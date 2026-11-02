<script setup lang="ts">
/**
 * [VIEW] 会话栏顶部多账号 <16ms 零闪烁快切器
 * 严格遵循零本地 ref / reactive 约束，所有状态均来自 chatStore 与 telegramStore。
 */
import { Check, ChevronDown, Layers, Wifi } from '@lucide/vue';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';

const chatStore = useChatStore();
const telegramStore = useTelegramStore();

function accountDisplayName(acc: { first_name: string | null; last_name: string | null; username: string | null; tg_user_id: string }): string {
  return [acc.first_name, acc.last_name].filter(Boolean).join(' ') || (acc.username ? `@${acc.username}` : acc.tg_user_id);
}

function accountInitials(acc: { first_name: string | null; last_name: string | null; username: string | null; tg_user_id: string }): string {
  const name = accountDisplayName(acc).replace(/^@/, '').trim();
  return (name[0] ?? 'T').toUpperCase();
}

function getPoolTier(accountId: string): 'P0' | 'P1' | 'P2' | null {
  if (telegramStore.currentAccountId === accountId) return 'P0';
  const entry = telegramStore.warmPoolAccounts.find((item) => item.accountId === accountId);
  return entry?.tier ?? null;
}

function getSnapshotUnreadCount(accountId: string): number {
  if (accountId === chatStore.accountId) return chatStore.unreadChatCount;
  const snap = chatStore.accountSnapshots[accountId];
  if (!snap) return 0;
  return Object.values(snap.dialogs).filter(
    (d) => (d.folderId ?? 0) === 0 && !d.muted && (d.unreadCount > 0 || d.unreadMark),
  ).length;
}
</script>

<template>
  <div v-if="telegramStore.accounts.length > 0" class="relative">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/40 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent/60"
      title="切换活跃 Telegram 账号（P0/P1 内存热池 <16ms 零闪烁切换）"
      @click="chatStore.toggleAccountSwitcher()"
    >
      <div class="flex min-w-0 items-center gap-2">
        <span class="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">
          {{ telegramStore.currentAccount ? accountInitials(telegramStore.currentAccount) : 'T' }}
        </span>
        <span class="truncate font-medium text-foreground">
          {{ chatStore.accountLabel || '选择账号' }}
        </span>
        <span class="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-semibold text-primary">
          P0
        </span>
      </div>

      <div class="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <span
          v-if="telegramStore.warmPoolAccounts.length > 1"
          class="flex items-center gap-0.5 text-[10px]"
          :title="`${telegramStore.warmPoolAccounts.length} 个账号已在内存热池保活`"
        >
          <Layers class="size-3" />
          {{ telegramStore.warmPoolAccounts.length }}
        </span>
        <ChevronDown
          class="size-3.5 transition-transform duration-150"
          :class="chatStore.isAccountSwitcherOpen ? 'rotate-180' : ''"
        />
      </div>
    </button>

    <!-- 多账号快切浮层 -->
    <div
      v-if="chatStore.isAccountSwitcherOpen"
      class="absolute left-0 right-0 top-full z-40 mt-1 overflow-hidden rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <div class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
        <span>Telegram 账号热池 ({{ telegramStore.accounts.length }})</span>
        <span class="flex items-center gap-1 text-[10px] text-primary">
          <Wifi class="size-2.5" /> &lt;16ms 热切
        </span>
      </div>

      <button
        v-for="acc in telegramStore.accounts"
        :key="acc.tg_user_id"
        type="button"
        class="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
        :class="acc.tg_user_id === telegramStore.currentAccountId ? 'bg-accent/60 font-medium' : ''"
        @click="chatStore.switchForegroundAccount(acc.tg_user_id)"
      >
        <div class="flex min-w-0 items-center gap-2">
          <span class="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-secondary-foreground">
            {{ accountInitials(acc) }}
          </span>
          <div class="min-w-0">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-foreground">{{ accountDisplayName(acc) }}</span>
              <span
                v-if="getPoolTier(acc.tg_user_id)"
                class="rounded px-1 py-0.2 text-[9px] font-semibold"
                :class="getPoolTier(acc.tg_user_id) === 'P0' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'"
              >
                {{ getPoolTier(acc.tg_user_id) }}
              </span>
            </div>
            <p class="truncate text-[10px] text-muted-foreground">
              {{ acc.username ? `@${acc.username}` : `ID ${acc.tg_user_id}` }}
              · {{ telegramStore.connectionStates[acc.tg_user_id] === 'online' ? '在线保活' : '待唤醒' }}
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <span
            v-if="getSnapshotUnreadCount(acc.tg_user_id) > 0"
            class="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground tabular-nums"
          >
            {{ getSnapshotUnreadCount(acc.tg_user_id) }}
          </span>
          <Check
            v-if="acc.tg_user_id === telegramStore.currentAccountId"
            class="size-3.5 text-primary"
          />
        </div>
      </button>
    </div>
  </div>
</template>
