<script setup lang="ts">
/**
 * 输入框原子组件（兜底表单控件）
 * ------------------------------------------------------------
 * 注意两条硬约束：
 * 1. 移动端字号必须 >= 16px，否则 iOS 获焦会推近视口；
 *    因此基础类里写的是 text-base，桌面才用 md:text-sm 降级，
 *    业务侧不要再写 text-sm / text-xs 把它覆盖掉。
 * 2. 错误态通过 aria-invalid 驱动（aria-invalid:border-destructive），
 *    业务只传 :aria-invalid="!!error"，不要自己拼红色描边。
 */
import type { HTMLAttributes } from 'vue'
import { useVModel } from '@vueuse/core'
import { cn } from '@/lib/utils'

const props = defineProps<{
  /** 非受控模式下的初始值 */
  defaultValue?: string | number
  /** v-model 绑定的值（受控模式） */
  modelValue?: string | number
  /** 追加类名 */
  class?: HTMLAttributes['class']
}>()

const emits = defineEmits<{
  (e: 'update:modelValue', payload: string | number): void
}>()

// useVModel 把「props + emit」包装成可直接 v-model 的响应式引用；
// passive: true 表示允许非受控使用（内部维护一份状态，同时仍会 emit 同步到父级）
const modelValue = useVModel(props, 'modelValue', emits, {
  passive: true,
  defaultValue: props.defaultValue,
})
</script>

<template>
  <!-- 原生 input：全宽、聚焦时显示品牌色焦点环，禁用态降到半透 -->
  <input
    v-model="modelValue"
    data-slot="input"
    :class="cn(
      'dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 disabled:bg-input/50 dark:disabled:bg-input/80 h-8 rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors file:h-6 file:text-sm file:font-medium focus-visible:ring-3 aria-invalid:ring-3 md:text-sm w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
      props.class,
    )"
  >
</template>
