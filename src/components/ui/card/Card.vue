<script setup lang="ts">
/**
 * 卡片骨架（shadcn-vue Card 套件）
 * ------------------------------------------------------------
 * Card 本身只负责「纯白内容面板 + 发丝线 + 12px 圆角」的容器语义，
 * 内部由 CardHeader / CardTitle / CardDescription / CardContent /
 * CardFooter / CardAction 这些子块在模板里自由拼装。
 * 子块通过 data-slot 互相感知（如 header 检测到 action 就切成两列网格），
 * 所以它们的顺序和从属关系不要随意改。
 */
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = withDefaults(defineProps<{
  /** 追加类名（交给 cn 与内置类合并，可覆盖圆角/背景等） */
  class?: HTMLAttributes['class']
  /** sm 为紧凑尺寸，用于侧栏、弹窗等密度更高的场合 */
  size?: 'default' | 'sm'
}>(), {
  size: 'default',
})
</script>

<template>
  <!-- ring-1 + ring-foreground/10：不用 border 而用外环，避免与内部子元素的边框叠加变粗 -->
  <div
    data-slot="card"
    :data-size="size"
    :class="cn('ring-foreground/10 bg-card text-card-foreground gap-4 overflow-hidden rounded-xl py-4 text-sm ring-1 has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col', props.class)"
  >
    <slot />
  </div>
</template>
