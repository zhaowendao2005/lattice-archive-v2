<script setup lang="ts">
import { computed } from 'vue';
import { Check } from '@lucide/vue';
import { useAppStore, type PlatformMode } from '@/stores/app/stores/appStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';

const appStore = useAppStore();
const chatStore = useChatStore();

const PLATFORMS: { mode: PlatformMode; label: string; hit: string; control: string; pad: string }[] = [
  { mode: 'ios', label: 'iOS', hit: '44 pt', control: '44px', pad: '16px' },
  { mode: 'ipados', label: 'iPadOS', hit: '44 pt', control: '40px', pad: '20px' },
  { mode: 'windows-standard', label: 'Windows', hit: '40 epx', control: '40px', pad: '16px' },
  { mode: 'windows-compact', label: 'Windows 紧凑', hit: '32 epx', control: '32px', pad: '12px' },
];

const active = computed(() => PLATFORMS.find((p) => p.mode === appStore.platform) ?? PLATFORMS[2]);

const POLICIES = [
  { title: 'WebKit 交互治理', detail: '双击放大拦截、手势缩放屏蔽已就绪，保持 0ms 触控响应。' },
  { title: 'DOM 结构绝对稳定', detail: '侧栏折叠由纯 CSS 宽度驱动，折叠前后 DOM Tree 节点严格恒定。' },
  { title: 'Pinia 分域三层拓扑', detail: '全仓 View 视图层零本地 ref，按 data-sources / stores / mocks 收拢。' },
];
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-2xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">平台与运行时</h2>
        <p class="mt-1 text-sm text-muted-foreground">跨端尺寸令牌即时切换、交互防御与架构策略落地情况</p>
      </header>

      <!-- 尺寸令牌切换 -->
      <section class="space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-sm font-medium">平台尺寸环境切换</span>
          <div class="inline-flex rounded-lg bg-muted p-0.5">
            <button
              v-for="p in PLATFORMS"
              :key="p.mode"
              type="button"
              :class="[
                'h-7 rounded-md px-3 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                appStore.platform === p.mode
                  ? 'bg-card text-foreground font-medium shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              ]"
              @click="appStore.setPlatform(p.mode)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>

        <dl class="grid grid-cols-2 sm:grid-cols-4 rounded-xl border border-border bg-card divide-x divide-border overflow-hidden">
          <div class="px-4 py-3">
            <dt class="text-xs text-muted-foreground">最小命中区</dt>
            <dd class="mt-1 text-lg font-semibold text-brand tabular-nums">{{ active.hit }}</dd>
          </div>
          <div class="px-4 py-3">
            <dt class="text-xs text-muted-foreground">控件基准高</dt>
            <dd class="mt-1 text-lg font-semibold text-brand tabular-nums">{{ active.control }}</dd>
          </div>
          <div class="px-4 py-3">
            <dt class="text-xs text-muted-foreground">内容边距</dt>
            <dd class="mt-1 text-lg font-semibold text-brand tabular-nums">{{ active.pad }}</dd>
          </div>
          <div class="px-4 py-3">
            <dt class="text-xs text-muted-foreground">活动会话数</dt>
            <dd class="mt-1 text-lg font-semibold tabular-nums">{{ chatStore.sessions.length }}</dd>
          </div>
        </dl>
      </section>

      <!-- 核心规范落地 -->
      <section class="space-y-3">
        <span class="text-sm font-medium">核心策略与架构规范落地情况</span>
        <ul class="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          <li v-for="item in POLICIES" :key="item.title" class="flex items-start gap-3 px-4 py-3.5">
            <Check class="mt-0.5 size-4 shrink-0 text-brand" :stroke-width="2" />
            <div>
              <div class="text-sm font-medium">{{ item.title }}</div>
              <p class="mt-0.5 text-xs text-muted-foreground">{{ item.detail }}</p>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
