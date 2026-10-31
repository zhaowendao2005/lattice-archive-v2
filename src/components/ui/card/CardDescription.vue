/**
 * 卡片描述 / 副标题：12 号灰色文字，用于补充标题没能说清的上下文。
 * 使用 text-muted-foreground 令牌，不得改成固定灰阶色值。
 */
<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  // 追加类名（如 line-clamp-2 限制行数）
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="card-description"
    :class="cn('text-muted-foreground text-sm', props.class)"
  >
    <slot />
  </div>
</template>
