<script setup lang="ts">
import { nextTick, watch } from 'vue';
import { useTelegramPerformanceStore } from '@/stores/telegram/stores/telegramPerformanceStore';

const performance = useTelegramPerformanceStore();

/** 并发字段层级依赖（静态说明，与契约层 TELEGRAM_CONCURRENCY_PARENT 一致）。 */
const DEPENDENCY_TREE = `账号级总活跃任务      ≥ 下面两项中较大者（不是两者之和）
├─ 账号级非媒体 RPC   ≤ 总活跃任务
│   ├─ 搜索并发
│   ├─ Chat 读取并发
│   ├─ Chat 命令并发
│   ├─ 机器人交互并发
│   ├─ 保险库转存并发
│   └─ 账号会话并发       （以上每项 ≤ 非媒体 RPC）
└─ 账号级媒体 RPC     ≤ 总活跃任务
    ├─ 封面并发
    │   └─ 搜索封面保留槽位  （≤ 封面并发）
    ├─ 头像并发
    ├─ 文件分片并发
    └─ 视频流分片并发      （以上每项 ≤ 媒体 RPC）

完整文件下载：同时下载的文件数，无上级限制；
每个文件的分片仍共用「文件分片并发」。`;

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
    <div class="rounded-xl border border-border bg-card px-4 py-3 space-y-2">
      <div class="text-xs font-medium">字段依赖关系</div>
      <pre class="overflow-x-auto font-mono text-xs leading-relaxed text-muted-foreground">{{ DEPENDENCY_TREE }}</pre>
      <p class="text-xs text-muted-foreground">
        子项的值不能超过其上级，上级调低后子项需同步调低；各字段没有固定数值上限，请结合网络与限流风险自行评估。
        运行中遇到限流或超时，系统会临时降低实际并发，但不会改动这里的数值。
      </p>
    </div>
    <form
      class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden"
      novalidate
      @submit.prevent="performance.applyCustom()"
    >
      <div v-for="field in performance.fields" :key="field.key" class="flex items-center justify-between gap-6 px-4 py-3">
        <label :for="`concurrency-${field.key}`" class="min-w-0">
          <div class="text-sm font-medium">{{ field.label }}</div>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ field.hint }}</p>
          <p class="mt-0.5 text-xs text-muted-foreground tabular-nums">
            最小 {{ field.min }} · {{ field.constraint }}
            <span v-if="field.error" class="text-destructive"> · {{ field.error }}</span>
          </p>
        </label>
        <input
          v-if="performance.isCustom"
          :id="`concurrency-${field.key}`"
          type="number"
          inputmode="numeric"
          :min="field.min"
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
