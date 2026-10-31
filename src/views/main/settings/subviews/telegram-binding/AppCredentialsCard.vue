<script setup lang="ts">
import { ArrowUpRight, KeyRound, LoaderCircle, ShieldCheck } from 'lucide-vue-next';
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';

const store = useTelegramStore();
async function save() { await store.validateAndSaveCredentials(); }
</script>

<template>
  <!-- 使用容器查询：设置页内容区宽度与视口无关，按卡片自身宽度切换布局，避免窄栏被挤压。 -->
  <section class="@container overflow-hidden rounded-lg border border-border bg-card shadow-xs">
    <header class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 pt-5 @lg:px-6 @lg:pt-6">
      <div class="flex min-w-0 flex-1 items-start gap-3">
        <div class="grid size-10 shrink-0 place-items-center rounded-lg bg-brand-soft text-primary">
          <KeyRound class="size-5" />
        </div>
        <div class="min-w-0">
          <h3 class="text-base font-semibold text-foreground">Telegram 应用凭据</h3>
          <p class="mt-1 text-[13px] leading-5 text-muted-foreground">
            每个账户仅配置一个应用，保存新凭据会替换当前配置。
          </p>
        </div>
      </div>
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        :class="store.credentials ? 'bg-brand-soft text-primary' : 'bg-muted text-muted-foreground'"
      >
        <span class="size-1.5 rounded-full" :class="store.credentials ? 'bg-primary' : 'bg-muted-foreground/50'"></span>
        {{ store.credentials ? '已配置' : '未配置' }}
      </span>
    </header>

    <dl
      v-if="store.credentials"
      class="mx-5 mt-5 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border @lg:mx-6 @xl:grid-cols-4"
    >
      <div class="min-w-0 bg-muted/40 px-3.5 py-2.5">
        <dt class="text-[11px] text-muted-foreground">应用 ID</dt>
        <dd class="mt-0.5 truncate text-sm font-medium text-foreground tabular-nums">{{ store.credentials.apiId }}</dd>
      </div>
      <div class="min-w-0 bg-muted/40 px-3.5 py-2.5">
        <dt class="text-[11px] text-muted-foreground">应用密钥</dt>
        <dd class="mt-0.5 truncate text-sm font-medium text-foreground">{{ store.credentials.apiHashMask }}</dd>
      </div>
      <div v-for="fact in store.credentialFacts" :key="fact.label" class="min-w-0 bg-muted/40 px-3.5 py-2.5">
        <dt class="text-[11px] text-muted-foreground">{{ fact.label }}</dt>
        <dd class="mt-0.5 truncate text-sm font-medium text-foreground tabular-nums">{{ fact.value }}</dd>
      </div>
    </dl>

    <div class="grid gap-4 px-5 py-5 @lg:px-6 @md:grid-cols-2">
      <label class="block min-w-0">
        <span class="text-[13px] font-medium text-foreground">应用 ID</span>
        <input
          :value="store.apiIdInput"
          inputmode="numeric"
          autocomplete="off"
          placeholder="api_id"
          class="token-control-height mt-1.5 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground tabular-nums outline-none transition placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-ring"
          @input="store.setApiIdInput(($event.target as HTMLInputElement).value)"
        />
      </label>
      <label class="block min-w-0">
        <span class="text-[13px] font-medium text-foreground">应用密钥</span>
        <input
          :value="store.apiHashInput"
          type="password"
          autocomplete="new-password"
          :placeholder="store.credentials ? '留空则沿用当前密钥' : 'api_hash'"
          class="token-control-height mt-1.5 w-full rounded-lg border border-input bg-card px-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground focus:border-brand focus:ring-2 focus:ring-ring"
          @input="store.setApiHashInput(($event.target as HTMLInputElement).value)"
        />
      </label>
      <p
        v-if="store.error"
        class="rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-[13px] text-destructive @md:col-span-2"
      >
        {{ store.error }}
      </p>
    </div>

    <footer class="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-t border-border bg-muted/40 px-5 py-3.5 @lg:px-6">
      <p class="flex min-w-0 flex-1 basis-60 items-start gap-2 text-xs leading-5 text-muted-foreground">
        <ShieldCheck class="mt-0.5 size-3.5 shrink-0 text-primary" />
        <span>远端仅保存应用凭据；Telegram 会话密钥只留在本设备，不会上传。</span>
      </p>
      <button
        type="button"
        class="token-control-height inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        @click="save"
      >
        <LoaderCircle v-if="store.isValidating" class="size-4 animate-spin" />
        {{ store.isValidating ? '正在验证' : store.credentials ? '验证并更新' : '验证并保存' }}
        <ArrowUpRight v-if="!store.isValidating" class="size-4" />
      </button>
    </footer>
  </section>
</template>
