<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { useTelegramPerformanceStore } from '@/stores/telegram/stores/telegramPerformanceStore';

const performance = useTelegramPerformanceStore();

// 提交校验失败时聚焦第一个错误项（只读 Store 信号，不持有本地状态）。
watch(() => performance.focusKey, async (key) => {
  if (!key) return;
  await nextTick();
  document.getElementById(`concurrency-${key}`)?.focus();
  performance.consumeFocus();
});
</script>

<template>
  <section class="space-y-3">
    <span class="text-sm font-medium">{{ performance.isCustom ? '自定义配额' : '当前生效配额' }}</span>
    <form
      class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden"
      novalidate
      @submit.prevent="performance.applyCustom()"
    >
      <div v-for="field in performance.fields" :key="field.key" class="flex items-center justify-between gap-6 px-4 py-3">
        <label :for="`concurrency-${field.key}`" class="min-w-0">
          <div class="text-sm font-medium">{{ field.label }}</div>
          <p class="mt-0.5 text-xs text-muted-foreground tabular-nums">
            范围 {{ field.min }}–{{ field.max }}
            <span v-if="field.error" class="text-destructive"> · {{ field.error }}</span>
          </p>
        </label>
        <input
          v-if="performance.isCustom"
          :id="`concurrency-${field.key}`"
          type="number"
          inputmode="numeric"
          :min="field.min"
          :max="field.max"
          :value="field.value"
          :aria-invalid="Boolean(field.error)"
          :class="[
            'h-8 w-20 shrink-0 rounded-lg border bg-card px-2 text-right text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
            field.error ? 'border-destructive' : 'border-border',
          ]"
          @input="performance.updateDraft(field.key, ($event.target as HTMLInputElement).value)"
        />
        <span v-else class="text-sm font-semibold tabular-nums">{{ field.applied }}</span>
      </div>
      <div v-if="performance.isCustom" class="flex justify-end px-4 py-3">
        <button
          type="submit"
          class="inline-flex h-8 items-center rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          保存并生效
        </button>
      </div>
    </form>
  </section>
</template>
