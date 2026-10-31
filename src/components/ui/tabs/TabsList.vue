/**
 * 页签列表（页签按钮的容器）
 * 两种形态：default = 灰底滑轨 + 选中项白底卡片；line = 无底色 + 底部细指示线。
 * 选哪种由 variant 决定，具体样式集中在 tabs/index.ts 的 tabsListVariants。
 */
<script setup lang="ts">
import type { TabsListProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import type { TabsListVariants } from '.'
import { reactiveOmit } from '@vueuse/core'
import { TabsList } from 'reka-ui'
import { cn } from '@/lib/utils'
import { tabsListVariants } from '.'

const props = withDefaults(defineProps<TabsListProps & {
  class?: HTMLAttributes['class']
  variant?: TabsListVariants['variant']
}>(), {
  variant: 'default',
})

// variant 由本组件消费（用于取样式），因此从透传属性里排除
const delegatedProps = reactiveOmit(props, 'class', 'variant')
</script>

<template>
  <TabsList
    data-slot="tabs-list"
    :data-variant="variant"
    v-bind="delegatedProps"
    :class="cn(tabsListVariants({ variant }), props.class)"
  >
    <slot />
  </TabsList>
</template>
