<script setup lang="ts">
import { Activity, ScrollText } from '@lucide/vue';
import type { Component } from 'vue';
import { useAppStore } from '@/stores/app/stores/appStore';

interface SubNavItem {
  name: string;
  label: string;
  icon: Component;
  /** 仅在开发者模式开启时显示。 */
  developerOnly?: boolean;
}

/** 二级列表：未来新增诊断页只需在此追加并注册嵌套路由。 */
const ITEMS: SubNavItem[] = [
  { name: 'settings-developer-logs', label: '日志', icon: ScrollText },
  { name: 'settings-developer-telegram', label: 'Telegram 连接监控', icon: Activity, developerOnly: true },
];

const appStore = useAppStore();
</script>

<template>
  <nav class="w-48 shrink-0 overflow-y-auto border-r border-border bg-card px-2 py-4 space-y-1" aria-label="开发者选项">
    <p class="px-3 pb-2 text-xs font-medium text-muted-foreground">开发者选项</p>
    <!-- 开发者模式关闭时用 CSS 隐藏监控入口，DOM 结构保持稳定。 -->
    <RouterLink
      v-for="item in ITEMS"
      :key="item.name"
      :to="{ name: item.name }"
      custom
      #default="{ navigate, isActive }"
    >
      <button
        type="button"
        :class="[
          'w-full h-9 items-center rounded-lg px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          item.developerOnly && !appStore.developerMode ? 'hidden' : 'flex',
          isActive ? 'bg-accent text-foreground font-medium' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        ]"
        @click="navigate()"
      >
        <component :is="item.icon" class="size-4 shrink-0" :stroke-width="1.75" />
        <span class="ml-2.5 truncate text-left">{{ item.label }}</span>
      </button>
    </RouterLink>
    <p :class="['px-3 pt-3 text-xs text-muted-foreground', appStore.developerMode ? 'hidden' : 'block']">
      开启「日志」页中的开发者模式后可使用 Telegram 连接监控。
    </p>
  </nav>
</template>
