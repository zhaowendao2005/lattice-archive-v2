<script setup lang="ts">
import { Code2, Database, Laptop, Palette, SlidersHorizontal } from '@lucide/vue';
import { useAppStore, type SettingsSubTab } from '@/stores/app/stores/appStore';

const appStore = useAppStore();

interface NavItem {
  key: SettingsSubTab;
  label: string;
  icon: any;
}

const NAV_ITEMS: NavItem[] = [
  { key: 'platform', label: '平台与运行时', icon: SlidersHorizontal },
  { key: 'appearance', label: '外观与显示', icon: Palette },
  { key: 'general', label: '通用设置', icon: Laptop },
  { key: 'developer', label: '开发者选项', icon: Code2 },
  { key: 'storage', label: '数据与归档', icon: Database },
];
</script>

<template>
  <aside class="w-60 min-w-[220px] max-w-[260px] shrink-0 flex flex-col border-r border-border bg-card">
    <div class="shrink-0 px-4 pt-4 pb-3">
      <h1 class="text-base font-semibold tracking-tight">设置</h1>
      <p class="text-xs text-muted-foreground mt-0.5">系统偏好与运行时控制</p>
    </div>

    <nav class="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
      <button
        v-for="item in NAV_ITEMS"
        :key="item.key"
        type="button"
        :class="[
          'w-full token-control-height flex items-center rounded-lg px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          appStore.activeSettingsTab === item.key
            ? 'bg-accent text-foreground font-medium'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
        ]"
        @click="appStore.setActiveSettingsTab(item.key)"
      >
        <component :is="item.icon" class="size-4 shrink-0" :stroke-width="1.75" />
        <span class="ml-2.5 truncate text-left">{{ item.label }}</span>
      </button>
    </nav>
  </aside>
</template>
