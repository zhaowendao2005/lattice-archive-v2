/**
 * 按钮样式表 + 组件再导出
 * ------------------------------------------------------------
 * cva（class-variance-authority）= 用「变体 → 类名」的映射描述组件外观。
 * 拆成独立文件的好处：任何地方都能通过 buttonVariants({variant:'outline'}) 取到
 * 与按钮完全一致的类名，用于 <a>、<RouterLink> 等非 button 元素，避免样式漂移。
 */
import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

// 统一出口：使用方只写 import { Button } from '@/components/ui/button'
export { default as Button } from './Button.vue'

/** 第一段是「所有按钮共有」的基础类（焦点环、圆角、禁用态、svg 尺寸等） */
export const buttonVariants = cva(
  'focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-lg border border-transparent bg-clip-padding text-sm font-medium focus-visible:ring-3 aria-invalid:ring-3 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*=size-])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      // 语义变体：一律使用设计令牌（bg-primary / border-border ...），禁止调色板色值
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        outline: 'border-border bg-background hover:bg-muted hover:text-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost: 'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive: 'bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      // 尺寸变体：高度逐级递减，icon-* 为正方形图标按钮
      size: {
        'default': 'h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        'xs': 'h-6 gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3',
        'sm': 'h-7 gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-lg has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3.5',
        'lg': 'h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
        'icon': 'size-8',
        'icon-xs': 'size-6 rounded-[min(var(--radius-md),10px)] in-data-[slot=button-group]:rounded-lg [&_svg:not([class*=size-])]:size-3',
        'icon-sm': 'size-7 rounded-[min(var(--radius-md),12px)] in-data-[slot=button-group]:rounded-lg',
        'icon-lg': 'size-9',
      },
    },
    // 不传参时的默认外观
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)
/** 从样式表反推出可用的 variant / size 联合类型，供组件 props 复用 */
export type ButtonVariants = VariantProps<typeof buttonVariants>
