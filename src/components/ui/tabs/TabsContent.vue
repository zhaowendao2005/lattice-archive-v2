/**
 * 页签内容面板：只渲染「当前选中页签」对应的内容区域。
 * reka-ui 会在非选中时卸载（或隐藏）内容，因此这里不需要写 v-if。
 */
<script setup lang="ts">
import type { TabsContentProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { TabsContent } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<TabsContentProps & {
  // 追加类名
  class?: HTMLAttributes['class']
}>()

// class 单独合并，其余属性（value 等）透传
const delegatedProps = reactiveOmit(props, 'class')
</script>

<template>
  <TabsContent
    data-slot="tabs-content"
    :class="cn('text-sm flex-1 outline-none', props.class)"
    v-bind="delegatedProps"
  >
    <slot />
  </TabsContent>
</template>
