<script setup lang="ts">
import { X } from '@lucide/vue';

/** 纯展示的圆形进度：percent 0–100；cancelable 时中央显示 ✕。颜色继承 currentColor。 */
const props = withDefaults(defineProps<{ percent: number; size?: number; stroke?: number; cancelable?: boolean }>(), { size: 48, stroke: 3, cancelable: false });
const RADIUS = 20;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
</script>

<template>
  <span class="relative inline-flex items-center justify-center" :style="{ width: `${props.size}px`, height: `${props.size}px` }">
    <svg viewBox="0 0 48 48" class="absolute inset-0 size-full -rotate-90" aria-hidden="true">
      <circle cx="24" cy="24" :r="RADIUS" fill="none" stroke="currentColor" :stroke-width="props.stroke" class="opacity-25" />
      <circle
        cx="24"
        cy="24"
        :r="RADIUS"
        fill="none"
        stroke="currentColor"
        :stroke-width="props.stroke"
        stroke-linecap="round"
        :stroke-dasharray="CIRCUMFERENCE"
        :stroke-dashoffset="CIRCUMFERENCE * (1 - Math.min(100, Math.max(2, props.percent)) / 100)"
        class="transition-[stroke-dashoffset] duration-200"
      />
    </svg>
    <X v-if="props.cancelable" class="size-1/3" :stroke-width="2" />
    <slot />
  </span>
</template>
