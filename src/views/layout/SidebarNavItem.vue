<!--
  ============================================================================
  侧栏导航项（纯展示原子组件）
  ============================================================================
  无状态：active / collapsed / badge 全部由父级传入。
  注意：它不是 <a>，而是 <button>，因为父级用 RouterLink 的 custom 模式包裹并
  在 @click 里调用 navigate()；这样既能沿用统一视觉，又保留路由语义。
-->
<script setup lang="ts">
import type { Component } from 'vue';

const props = defineProps<{
  /** 图标组件（lucide） */
  icon: Component;
  /** 中文标签 */
  label: string;
  /** 侧栏是否折叠：折叠时只留图标 */
  collapsed: boolean;
  /** 是否为当前路由 */
  active?: boolean;
  /** 右侧角标文本（如未读数） */
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
