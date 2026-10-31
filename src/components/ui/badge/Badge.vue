<!--
  徽标原子组件：未读数、角色标签、状态胶囊等场景
  ------------------------------------------------------------
  项目规范：圆形/胶囊（pill）圆角仅用于头像、未读 Badge、在线状态圆点，
  因此这里直接用 rounded-4xl 的胶囊形态。
-->
<script setup lang="ts">
import type { PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import type { BadgeVariants } from '.'
import { reactiveOmit } from '@vueuse/core'
import { Primitive } from 'reka-ui'
import { cn } from '@/lib/utils'
import { badgeVariants } from '.'

const props = defineProps<PrimitiveProps & {
  variant?: BadgeVariants['variant']
  class?: HTMLAttributes['class']
}>()

// 把 class 之外的属性（as / asChild / 事件等）原样透传给 Primitive，
// class 单独交给 cn() 合并，避免被 v-bind 覆盖
const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <!-- data-variant 会渲染到 DOM 上，供外部 CSS 按语义变体做微调 -->
  <Primitive
    data-slot="badge"
    :data-variant="variant"
    :class="cn(badgeVariants({ variant }), props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </Primitive>
</template>
