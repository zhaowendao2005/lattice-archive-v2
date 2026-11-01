<script setup lang="ts">
import { CheckCircle2, Info, PanelLeft, PanelRight, Search, X } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';

const searchStore = useAggregateSearchStore();
</script>

<template>
  <header class="flex shrink-0 items-center gap-2.5 border-b border-white/10 bg-black/20 px-4 py-2.5">
    <!-- 应用方角徽标 -->
    <span
      class="flex size-[26px] shrink-0 items-center justify-center rounded-[2px] border border-sky-400/35 bg-sky-500/15 text-sky-300 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)]"
    >
      <Search class="size-3.5" :stroke-width="2" />
    </span>

    <!-- 标题与操作提示（i 图标 hover 浮动文案） -->
    <div class="flex min-w-0 items-center gap-2">
      <h2 class="truncate text-[14px] font-medium tracking-wide text-white/92">
        聚合搜索系统
      </h2>

      <div class="group relative flex items-center">
        <button
          type="button"
          class="flex size-5 items-center justify-center rounded-[2px] text-white/40 transition-colors hover:bg-white/10 hover:text-white/80 focus:outline-none"
          title="使用提示"
          aria-label="使用提示"
        >
          <Info class="size-3.5" :stroke-width="1.8" />
        </button>

        <!-- Hover 浮动卡片提示 -->
        <div
          class="pointer-events-none absolute left-0 top-full z-[100] mt-1.5 hidden w-72 rounded-[4px] border border-white/15 bg-[#141e30]/95 p-2.5 shadow-2xl backdrop-blur-xl group-hover:block transition-all duration-150"
        >
          <div class="flex items-center gap-1.5 text-[11px] font-medium text-sky-300">
            <Info class="size-3" />
            <span>检索与归档提示</span>
          </div>
          <p class="mt-1 font-mono text-[10px] leading-relaxed text-white/70">
            流式检索 · 按住 Shift 连续多选 · 向左拖入 Explore 归档
          </p>
        </div>
      </div>
    </div>

    <!-- 归档落位反馈横幅（常驻容器，通过透明度切换） -->
    <div
      class="ml-3 flex items-center gap-1.5 rounded-[2px] border px-2 py-0.5 text-[11px] transition-opacity duration-200"
      :class="
        searchStore.lastImportBannerText
          ? 'border-sky-400/40 bg-sky-500/15 text-sky-200 opacity-100'
          : 'pointer-events-none border-transparent bg-transparent text-transparent opacity-0'
      "
    >
      <CheckCircle2 class="size-3 shrink-0 text-sky-400" />
      <span class="max-w-[260px] truncate">{{ searchStore.lastImportBannerText || '就绪' }}</span>
    </div>

    <!-- 右侧分栏显隐控制与关闭按钮 -->
    <div class="ml-auto flex shrink-0 items-center gap-1.5">
      <!-- 左栏（磁贴文件树 Explorer）显隐切换 -->
      <button
        type="button"
        class="flex h-[26px] items-center gap-1.5 rounded-[2px] border px-2 text-[11px] transition-colors"
        :class="
          searchStore.isLeftPaneOpen
            ? 'border-sky-400/45 bg-sky-500/20 text-sky-200'
            : 'border-white/10 bg-white/[0.03] text-white/45 hover:border-white/25 hover:text-white/85'
        "
        title="显示/隐藏左栏 Explore 树状视图"
        @click="searchStore.toggleLeftPane"
      >
        <PanelLeft class="size-3.5" :stroke-width="1.8" />
        <span class="hidden md:inline">Explore</span>
      </button>

      <!-- 右栏（会话搜索范围控制）显隐切换 -->
      <button
        type="button"
        class="flex h-[26px] items-center gap-1.5 rounded-[2px] border px-2 text-[11px] transition-colors"
        :class="
          searchStore.isRightPaneOpen
            ? 'border-sky-400/45 bg-sky-500/20 text-sky-200'
            : 'border-white/10 bg-white/[0.03] text-white/45 hover:border-white/25 hover:text-white/85'
        "
        title="显示/隐藏右栏会话搜索范围控制"
        @click="searchStore.toggleRightPane"
      >
        <PanelRight class="size-3.5" :stroke-width="1.8" />
        <span class="hidden md:inline">搜索范围</span>
        <span
          class="rounded-[2px] px-1 font-mono text-[10px] transition-opacity"
          :class="
            searchStore.selectedScopeSessionIds.length > 0
              ? 'bg-sky-400 text-slate-950 font-semibold opacity-100'
              : 'bg-white/10 text-white/50 opacity-75'
          "
        >
          {{
            searchStore.selectedScopeSessionIds.length > 0
              ? searchStore.selectedScopeSessionIds.length
              : '全'
          }}
        </span>
      </button>

      <div class="mx-0.5 h-3.5 w-px bg-white/10" />

      <!-- 关闭按钮 -->
      <button
        type="button"
        class="flex size-[26px] items-center justify-center rounded-[2px] border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:bg-white/10 hover:text-white"
        title="关闭聚合搜索 (Esc)"
        @click="searchStore.closeModal"
      >
        <X class="size-3.5" :stroke-width="1.75" />
      </button>
    </div>
  </header>
</template>
