<script setup lang="ts">
import { Code2, Database, Laptop, Palette, Send, SlidersHorizontal } from '@lucide/vue';
import type { Component } from 'vue';

export type SettingsSubTab = 'platform' | 'appearance' | 'developer' | 'general' | 'storage' | 'telegram';

interface NavItem {
  key: SettingsSubTab;
  label: string;
  icon: Component;
  disabled?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'telegram', label: '账户与绑定', icon: Send },
  { key: 'developer', label: '开发者选项', icon: Code2 },
  { key: 'storage', label: '数据与归档', icon: Database },
  { key: 'platform', label: '平台与运行时', icon: SlidersHorizontal, disabled: true },
  { key: 'appearance', label: '外观与显示', icon: Palette, disabled: true },
  { key: 'general', label: '通用设置', icon: Laptop, disabled: true },
];
</script>

<template>
  <aside class="w-60 min-w-[220px] max-w-[260px] shrink-0 flex flex-col border-r border-border bg-card">
    <div class="shrink-0 px-4 pt-4 pb-3">
      <h1 class="text-base font-semibold tracking-tight">设置</h1>
      <p class="text-xs text-muted-foreground mt-0.5">系统偏好与运行时控制</p>
    </div>

    <nav class="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
      <RouterLink
        v-for="item in NAV_ITEMS"
        :key="item.key"
        :to="{ name: `settings-${item.key}` }"
        custom
        #default="{ navigate, isActive }"
      >
        <button
          type="button"
          :disabled="item.disabled"
          :class="[
            'w-full token-control-height flex items-center rounded-lg px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
            item.disabled
              ? 'opacity-40 cursor-not-allowed text-muted-foreground/60 hover:bg-transparent'
              : isActive
                ? 'bg-accent text-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
          ]"
          @click="item.disabled ? null : navigate()"
        >
          <component :is="item.icon" class="size-4 shrink-0" :stroke-width="1.75" />
          <span class="ml-2.5 truncate text-left">{{ item.label }}</span>
          <span
            v-if="item.disabled"
            class="ml-auto rounded-sm border border-border/40 bg-muted/40 px-1.5 py-0.2 font-mono text-[9px] text-muted-foreground/75"
          >
            未启用
          </span>
        </button>
      </RouterLink>
    </nav>
  </aside>
</template>
