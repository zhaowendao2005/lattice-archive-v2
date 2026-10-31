/**
 * 卡片右上角操作插槽：
 * 它靠「固定到网格第 2 列、跨 2 行、顶部对齐」实现与标题同行、与描述对齐，
 * 同时 CardHeader 因为检测到它而切换成两列布局。
 */
<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  // 追加类名（如 flex gap-1 放多个图标按钮）
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="card-action"
    :class="cn('col-start-2 row-span-2 row-start-1 self-start justify-self-end', props.class)"
  >
    <slot />
  </div>
</template>
