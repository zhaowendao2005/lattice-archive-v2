/**
 * ============================================================================
 * Tailwind 类名合并工具（shadcn-vue 体系的标准辅助函数）
 * ============================================================================
 * 组件库里常见写法：`cn('px-2 py-1', props.class, { 'bg-primary': active })`。
 * 直接字符串拼接会在「同一属性出现两次」时失效（例如基础 `px-2` 与外部传入 `px-4`），
 * 因为 CSS 权重相同、后写的未必赢。
 *
 * 这里的两步就是标准解法：
 *   1. clsx   ：把字符串 / 数组 / 对象（条件类名）摊平成一条类名字符串；
 *   2. twMerge：按 Tailwind 语义做冲突消解，后出现的同类工具类覆盖前面的。
 *
 * 例：cn('px-2 text-sm', 'px-4')  →  'text-sm px-4'
 */
import type { ClassValue } from "clsx"
import { clsx } from "clsx"
import { twMerge } from "tailwind-merge"

/**
 * 合并 Tailwind 类名并消解同属性冲突。
 * @param inputs 任意数量的类名来源（字符串、数组、条件对象）
 * @returns 去重且无冲突的类名字符串
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
