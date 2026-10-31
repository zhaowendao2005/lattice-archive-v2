<!--
  按钮原子组件（shadcn-vue 风格 + reka-ui Primitive）
  ------------------------------------------------------------
  · 只负责「外观 + 转发属性」，不含业务逻辑，符合视图零状态的架构约束；
  · variant / size 的样式定义在 index.ts 的 buttonVariants（cva）里，
    这样别处需要「长得像按钮的链接」时可只取类名而不引入组件；
  · Primitive 的 as/asChild 让它可以渲染成 button / a / RouterLink 而保持同一套样式。
-->
<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import type { ButtonVariants } from '.'
import { Primitive } from 'reka-ui'
import { cn } from '@/lib/utils'
import { buttonVariants } from '.'

interface Props extends PrimitiveProps {
  /** 语义变体：default 主操作 / outline 次级 / ghost 无底 / destructive 危险操作 */
  variant?: ButtonVariants['variant']
  /** 尺寸：xs / sm / default / lg / icon-* */
  size?: ButtonVariants['size']
  /** 外部追加的类名，经 cn() 合并后可覆盖内置类 */
  class?: HTMLAttributes['class']
}

const props = withDefaults(defineProps<Props>(), {
  as: 'button', // 默认渲染为真实的 <button>，保证可聚焦与键盘可达
})
</script>

<template>
  <!-- data-slot/data-variant 是给父级做属性选择器用的（例如 ButtonGroup 里的圆角修正） -->
  <Primitive
    data-slot="button"
    :data-variant="variant"
    :data-size="size"
    :as="as"
    :as-child="asChild"
    :class="cn(buttonVariants({ variant, size }), props.class)"
  >
    <slot />
  </Primitive>
</template>
