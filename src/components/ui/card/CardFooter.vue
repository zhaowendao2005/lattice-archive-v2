/**
 * 卡片底栏：操作按钮区。
 * 用 bg-muted/50 + 上发丝线与正文区分，属于「附注层」；
 * Card 在检测到 CardFooter 时会自动去掉底部内边距（has-data-[slot=card-footer]），
 * 让底栏贴着卡片圆角边缘。
 */
<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  // 追加类名（如 justify-end 让按钮靠右）
  class?: HTMLAttributes['class']
}>()
</script>

<template>
  <div
    data-slot="card-footer"
    :class="cn('bg-muted/50 rounded-b-xl border-t p-4 group-data-[size=sm]/card:p-3 flex items-center', props.class)"
  >
    <slot />
  </div>
</template>
