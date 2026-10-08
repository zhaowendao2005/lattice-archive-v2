<script setup lang="ts">
import { Moon, Monitor, Sun } from '@lucide/vue';
import { useAppStore, type ThemeMode } from '@/stores/app/stores/appStore';

const appStore = useAppStore();

const THEMES: { mode: ThemeMode; label: string; desc: string; icon: any }[] = [
  { mode: 'system', label: '跟随系统', desc: '根据操作系统自动切换亮色或暗色', icon: Monitor },
  { mode: 'light', label: '瑞士白底', desc: '纯净通透的高对比度浅色科技蓝', icon: Sun },
  { mode: 'dark', label: '深邃夜间', desc: '沉浸护眼的低眩光深蓝暗色模式', icon: Moon },
];
</script>

<template>
  <div class="h-full overflow-y-auto">
    <div class="mx-auto max-w-2xl px-8 py-8 space-y-8">
      <header>
        <h2 class="text-lg font-semibold tracking-tight">外观与显示</h2>
        <p class="mt-1 text-sm text-muted-foreground">定制界面主题、色彩风格与视觉对比度</p>
      </header>

      <!-- 主题切换 -->
      <section class="space-y-3">
        <span class="text-sm font-medium">主题模式</span>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <button
            v-for="item in THEMES"
            :key="item.mode"
            type="button"
            :class="[
              'p-4 rounded-xl border text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-ring flex flex-col justify-between',
              appStore.themeMode === item.mode
                ? 'border-brand bg-brand-soft/40 ring-1 ring-brand'
                : 'border-border bg-card hover:bg-muted/50'
            ]"
            @click="appStore.setThemeMode(item.mode)"
          >
            <div class="flex items-center justify-between w-full mb-3">
              <component
                :is="item.icon"
                :class="['size-5', appStore.themeMode === item.mode ? 'text-brand' : 'text-muted-foreground']"
                :stroke-width="1.75"
              />
              <span
                v-if="appStore.themeMode === item.mode"
                class="size-2 rounded-full bg-brand"
              />
            </div>
            <div>
              <div class="text-sm font-medium">{{ item.label }}</div>
              <p class="text-xs text-muted-foreground mt-0.5 leading-snug">{{ item.desc }}</p>
            </div>
          </button>
        </div>
      </section>

      <!-- 当前调色板说明 -->
      <section class="space-y-3">
        <span class="text-sm font-medium">当前应用色板</span>
        <div class="p-4 rounded-xl border border-border bg-card space-y-3">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">Swiss Tech Blue (瑞士科技蔚蓝)</span>
            <span class="text-xs font-mono px-2 py-0.5 rounded-full bg-brand-soft text-brand font-medium">OKLCH</span>
          </div>
          <p class="text-xs text-muted-foreground leading-relaxed">
            核心主色为深邃科技蓝，辅以高饱和蔚蓝聚焦线与未读标记，纯白/深冷面板与无衬线微距排版结合，保证信息呈现绝对干脆利落。
          </p>
          <div class="flex gap-2 pt-1">
            <div class="h-6 flex-1 rounded bg-primary" title="Primary" />
            <div class="h-6 flex-1 rounded bg-brand" title="Brand" />
            <div class="h-6 flex-1 rounded bg-brand-soft border border-border" title="Brand Soft" />
            <div class="h-6 flex-1 rounded bg-muted" title="Muted" />
            <div class="h-6 flex-1 rounded bg-accent" title="Accent" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
