<script setup lang="ts">
import { Gauge, RotateCcw } from '@lucide/vue';
import { useTelegramPerformanceStore } from '@/stores/telegram/stores/telegramPerformanceStore';
import type { TelegramConcurrencyMode } from '@/worker/local/telegram/contracts/concurrency';
import ConcurrencyCustomForm from './performance/ConcurrencyCustomForm.vue';

const performance = useTelegramPerformanceStore();
const MODES: { key: TelegramConcurrencyMode; label: string; hint: string }[] = [
  { key: 'stable', label: '稳定', hint: '移动网络或低内存设备，优先减少超时与限流' },
  { key: 'balanced', label: '均衡（默认）', hint: '搜索与封面明显提速，同时保留足够余量' },
  { key: 'aggressive', label: '积极', hint: '网络与设备较好时使用，搜索、封面、下载吞吐最高' },
  { key: 'custom', label: '自定义', hint: '在本地安全范围内逐项调整' },
];
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-2xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">性能与网络</h2>
        <p class="mt-1 text-sm text-muted-foreground">Telegram 搜索、封面与媒体下载的并发配额</p>
      </header>

      <section class="space-y-3">
        <span class="text-sm font-medium">并发模式</span>
        <div class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          <p class="flex items-start gap-2 px-4 py-3 text-xs text-muted-foreground">
            <Gauge class="mt-0.5 size-4 shrink-0" :stroke-width="1.75" />
            并发越高，搜索、封面与下载越快，但会增加网络、内存和 Telegram 限流风险。遇到限流或超时时，系统会临时降低实际并发，恢复后逐步回到这里设置的上限；所有请求仍共用每个账号的同一条连接。
          </p>
          <button
            v-for="option in MODES"
            :key="option.key"
            type="button"
            role="radio"
            :aria-checked="performance.mode === option.key"
            class="flex w-full items-center justify-between gap-6 px-4 py-3.5 text-left transition-colors hover:bg-muted/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            @click="performance.selectMode(option.key)"
          >
            <div>
              <div class="text-sm font-medium">{{ option.label }}</div>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ option.hint }}</p>
            </div>
            <span
              :class="[
                'size-4 shrink-0 rounded-full border transition-colors',
                performance.mode === option.key ? 'border-brand bg-brand' : 'border-border bg-card',
              ]"
            />
          </button>
        </div>
        <div class="flex items-center justify-between gap-4">
          <p class="text-xs text-muted-foreground" role="status">{{ performance.notice }}</p>
          <button
            type="button"
            class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            @click="performance.resetDefault()"
          >
            <RotateCcw class="size-3.5" :stroke-width="1.75" />恢复默认
          </button>
        </div>
      </section>

      <ConcurrencyCustomForm />
    </div>
  </div>
</template>
