/**
 * 卡片正文区：只负责水平内边距（16px / 紧凑 12px），不管垂直间距——
 * 垂直间距由 Card 的 gap-4 统一控制，避免子块各自加 margin 造成叠加。
 */
<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  // 追加类名（如 px-0 做全宽表格、图片）
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="card-content"
    :class="cn('px-4 group-data-[size=sm]/card:px-3', props.class)"
  >
    <slot />
  </div>
</template>
