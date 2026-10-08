<script setup lang="ts">
import type { Component } from 'vue';

const props = defineProps<{
  icon: Component;
  label: string;
  collapsed: boolean;
  active?: boolean;
  badge?: string | number;
}>();
</script>

<template>
  <!-- 折叠仅切换类名，DOM 结构恒定 -->
  <button
    type="button"
    :title="props.label"
    :aria-current="props.active ? 'page' : undefined"
    :class="[
      'w-full token-control-height flex items-center rounded-md px-2.5 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
      props.active
        ? 'bg-accent text-foreground font-medium'
        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
    ]"
  >
    <component :is="props.icon" class="size-5 shrink-0" :stroke-width="1.75" />
    <span
      :class="[
        'flex-1 flex items-center justify-between overflow-hidden whitespace-nowrap text-left transition-[max-width,opacity,margin] duration-200',
        props.collapsed ? 'ml-0 max-w-0 opacity-0' : 'ml-2.5 max-w-44 opacity-100'
      ]"
    >
      <span>{{ props.label }}</span>
      <span class="text-xs font-normal text-muted-foreground tabular-nums">{{ props.badge }}</span>
    </span>
  </button>
</template>
