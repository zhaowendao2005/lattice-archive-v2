<script setup lang="ts">
import { computed } from 'vue';
import { ArrowUpRight, Check, Fingerprint, KeyRound } from 'lucide-vue-next';
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';

const store = useTelegramStore();
const reportText = computed(() => store.credentials?.report ? JSON.stringify(store.credentials.report) : '验证后显示连接信息');
async function save() { await store.validateAndSaveCredentials(); }
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-card">
    <header class="grid gap-5 border-b border-border px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end sm:px-7 sm:py-6">
      <div>
        <div class="mb-3 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <span class="grid size-6 place-items-center rounded-full bg-primary text-primary-foreground">01</span>
          <span>连接配置</span>
        </div>
        <h3 class="text-xl font-semibold tracking-tight text-foreground">Telegram 应用凭据</h3>
        <p class="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
          每个账户仅配置一个 Telegram 应用。凭据用于本机建立连接；Telegram 登录会话只保存在此设备。
        </p>
      </div>
      <div class="flex items-center gap-2 self-start rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground sm:self-auto">
        <span class="size-1.5 rounded-full" :class="store.credentials ? 'bg-primary' : 'bg-muted-foreground/40'"></span>
        {{ store.credentials ? '凭据已配置' : '尚未配置' }}
      </div>
    </header>

    <div class="grid sm:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
      <aside class="border-b border-border bg-muted/50 px-5 py-5 sm:border-b-0 sm:border-r sm:px-7 sm:py-7">
        <div class="flex items-start gap-3">
          <div class="grid size-9 shrink-0 place-items-center rounded-lg border border-border bg-card text-primary">
            <Fingerprint class="size-4" />
          </div>
          <div>
            <p class="text-sm font-medium text-foreground">单一应用凭据</p>
            <p class="mt-1 text-xs leading-5 text-muted-foreground">保存新的凭据会替换当前配置，不会创建第二条应用记录。</p>
          </div>
        </div>
        <div v-if="store.credentials" class="mt-6 border-t border-border pt-4">
          <p class="text-[11px] font-medium text-muted-foreground">当前 api_hash</p>
          <p class="mt-1 font-mono text-sm text-foreground">{{ store.credentials.apiHashMask }}</p>
        </div>
        <div class="mt-6 border-t border-border pt-4">
          <p class="text-[11px] font-medium text-muted-foreground">安全说明</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">远端仅保存应用凭据。会话密钥（auth_key）不会上传。</p>
        </div>
      </aside>

      <div class="space-y-5 px-5 py-5 sm:px-7 sm:py-7">
        <div class="grid gap-4 sm:grid-cols-2">
          <label class="block space-y-2">
            <span class="flex items-center gap-2 text-xs font-medium text-muted-foreground"><span class="text-primary">A</span> 应用 ID</span>
            <input :value="store.apiIdInput" inputmode="numeric" autocomplete="off" placeholder="输入 api_id" class="h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring" @input="store.setApiIdInput(($event.target as HTMLInputElement).value)" />
          </label>
          <label class="block space-y-2">
            <span class="flex items-center gap-2 text-xs font-medium text-muted-foreground"><span class="text-primary">B</span> 应用密钥</span>
            <input :value="store.apiHashInput" type="password" autocomplete="new-password" placeholder="输入 api_hash" class="h-11 w-full rounded-lg border border-input bg-background px-3 text-base text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-ring" @input="store.setApiHashInput(($event.target as HTMLInputElement).value)" />
          </label>
        </div>

        <div class="flex flex-col gap-4 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <div class="flex items-center gap-2 text-xs font-medium text-foreground">
              <Check v-if="store.credentials" class="size-3.5 text-primary" />
              <KeyRound v-else class="size-3.5 text-muted-foreground" />
              {{ store.credentials ? '凭据已保存' : '验证后保存唯一凭据' }}
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{{ reportText }}</p>
          </div>
          <button type="button" class="token-control-height inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90" @click="save">
            {{ store.isValidating ? '正在验证' : store.credentials ? '验证并更新' : '验证并保存' }}
            <ArrowUpRight v-if="!store.isValidating" class="size-4" />
          </button>
        </div>
        <p v-if="store.error" class="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ store.error }}</p>
      </div>
    </div>
  </section>
</template>
