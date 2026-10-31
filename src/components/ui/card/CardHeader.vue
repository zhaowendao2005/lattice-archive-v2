/**
 * 卡片头部：标题 / 描述 / 右上角操作（CardAction）的网格容器
 * 默认单列；当检测到内部有 CardAction 时自动变成「左文右操作」两列，
 * 检测到 CardDescription 时自动变成两行。子块的 data-slot 就是靠这个生效的。
 */
<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  // 追加类名，可用于加下边框（.border-b 时内部已有 pb-4 适配）
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="card-header"
    :class="cn('gap-1 rounded-t-xl px-4 group-data-[size=sm]/card:px-3 [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3 group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]', props.class)"
  >
    <slot />
  </div>
</template>
