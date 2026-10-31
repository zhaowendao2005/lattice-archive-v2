/**
 * Tabs 根容器（reka-ui TabsRoot 的薄封装）
 * ------------------------------------------------------------
 * 负责「选中哪个页签」的受控状态与键盘无障碍（←/→ 切换、roving tabindex），
 * 这里只把 props/emits 原样转发并补一层布局类名。
 */
<script setup lang="ts">
import type { TabsRootEmits, TabsRootProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'
import { reactiveOmit } from '@vueuse/core'
import { TabsRoot, useForwardPropsEmits } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<TabsRootProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<TabsRootEmits>()

// class 交给 cn() 合并；其余属性（modelValue、orientation 等）转发给 reka-ui
const delegatedProps = reactiveOmit(props, 'class')
const forwarded = useForwardPropsEmits(delegatedProps, emits)
</script>

<template>
  <!-- data-orientation 会叠加到 DOM，TabsList/Trigger 靠它决定橫向或纵向排列 -->
  <TabsRoot
    v-slot="slotProps"
    data-slot="tabs"
    :data-orientation="forwarded.orientation || 'horizontal'"
    v-bind="forwarded"
    :class="cn('gap-2 group/tabs flex data-horizontal:flex-col', props.class)"
  >
    <slot v-bind="slotProps" />
  </TabsRoot>
</template>
