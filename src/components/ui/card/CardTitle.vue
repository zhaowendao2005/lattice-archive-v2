/**
 * 卡片标题：16px / 中等字重，属于「区块标题」层级；
 * 卡片为 sm 紧凑尺寸时自动降为 14px，保证密度上升但层级不乱。
 */
<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  // 追加类名（例如改字号、限制行数）
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="card-title"
    :class="cn('text-base leading-snug font-medium group-data-[size=sm]/card:text-sm cn-font-heading', props.class)"
  >
    <slot />
  </div>
</template>
