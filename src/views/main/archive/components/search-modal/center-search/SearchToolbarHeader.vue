<script setup lang="ts">
import {
  ArrowUpDown,
  LayoutList,
  Loader2,
  Search,
  SlidersHorizontal,
  Sparkles,
  X,
} from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';

const searchStore = useAggregateSearchStore();

function handleTriggerSearch() {
  void searchStore.executeStreamingSearch();
}

function handleClearKeyword() {
  searchStore.keyword = '';
  void searchStore.executeStreamingSearch();
}
</script>

<template>
  <div class="flex shrink-0 items-center gap-2 border-b border-white/10 bg-black/20 px-4 py-3">
    <!-- 大尺寸搜索框（搜索按钮内嵌在搜索框右端内部） -->
    <div
      class="relative flex h-10 min-w-0 flex-1 items-center rounded-[2px] border border-white/15 bg-black/35 pl-3 pr-1.5 transition-colors focus-within:border-sky-400/80 focus-within:bg-black/55"
    >
      <Search class="mr-2.5 size-4 shrink-0 text-white/45" :stroke-width="1.9" />

      <input
        v-model="searchStore.keyword"
        type="text"
        placeholder="输入关键词聚合检索视频、图片、会话、文本文件与其他归档..."
        class="h-full min-w-0 flex-1 bg-transparent text-white placeholder-white/35 outline-none"
        @keydown.enter="handleTriggerSearch"
      />

      <!-- 清空关键词按钮（常驻 DOM，通过透明度控制显隐） -->
      <button
        type="button"
        class="mr-1.5 flex size-6 shrink-0 items-center justify-center rounded-[2px] text-white/40 transition-opacity hover:bg-white/10 hover:text-white"
        :class="searchStore.keyword ? 'opacity-100' : 'pointer-events-none opacity-0'"
        title="清空搜索词"
        @click="handleClearKeyword"
      >
        <X class="size-3.5" />
      </button>

      <!-- 内嵌在搜索框里面的「搜索」主按钮（遵循主按钮不置灰规范） -->
      <button
        type="button"
        class="flex h-7 shrink-0 items-center gap-1.5 rounded-[2px] bg-sky-500/90 px-3 text-xs font-medium text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-colors hover:bg-sky-400 active:bg-sky-600"
        @click="handleTriggerSearch"
      >
        <Loader2
          v-if="searchStore.isStreaming"
          class="size-3.5 animate-spin"
          :stroke-width="2"
        />
        <Search v-else class="size-3.5" :stroke-width="2" />
        <span>搜索</span>
      </button>
    </div>

    <!-- 搜索框右侧 SVG 图标按钮组：筛选按钮 + 预留 SVG 图标 -->
    <div class="flex shrink-0 items-center gap-1.5">
      <!-- 1. 核心图标：「筛选」（点击往下伸出筛选菜单） -->
      <button
        type="button"
        class="relative flex h-10 items-center gap-1.5 rounded-[2px] border px-3 text-xs transition-colors"
        :class="
          searchStore.isFilterMenuOpen || searchStore.activeFilterCount > 0
            ? 'border-sky-400/60 bg-sky-500/20 text-sky-200 shadow-[0_0_12px_rgba(56,189,248,0.2)]'
            : 'border-white/15 bg-white/[0.04] text-white/70 hover:border-white/30 hover:bg-white/[0.08] hover:text-white'
        "
        title="展开/收起搜索前与搜索后筛选菜单"
        @click="searchStore.toggleFilterMenu"
      >
        <SlidersHorizontal class="size-4" :stroke-width="1.8" />
        <span class="hidden sm:inline">筛选</span>
        <span
          class="rounded-[2px] px-1 font-mono text-[10px] font-semibold transition-opacity"
          :class="
            searchStore.activeFilterCount > 0
              ? 'bg-sky-400 text-slate-950 opacity-100'
              : 'hidden opacity-0'
          "
        >
          {{ searchStore.activeFilterCount }}
        </span>
      </button>

      <!-- 2. 预留 SVG 图标按钮 1：排序方式（预留） -->
      <button
        type="button"
        class="flex size-10 items-center justify-center rounded-[2px] border border-white/12 bg-white/[0.03] text-white/45 transition-colors hover:border-white/25 hover:bg-white/[0.07] hover:text-white/85"
        title="排序规则（预留功能）"
      >
        <ArrowUpDown class="size-4" :stroke-width="1.75" />
      </button>

      <!-- 3. 预留 SVG 图标按钮 2：视图密度（预留） -->
      <button
        type="button"
        class="flex size-10 items-center justify-center rounded-[2px] border border-white/12 bg-white/[0.03] text-white/45 transition-colors hover:border-white/25 hover:bg-white/[0.07] hover:text-white/85"
        title="卡片布局密度（预留功能）"
      >
        <LayoutList class="size-4" :stroke-width="1.75" />
      </button>

      <!-- 4. 预留 SVG 图标按钮 3：高级检索语法（预留） -->
      <button
        type="button"
        class="flex size-10 items-center justify-center rounded-[2px] border border-white/12 bg-white/[0.03] text-white/45 transition-colors hover:border-white/25 hover:bg-white/[0.07] hover:text-white/85"
        title="语义与正则增强（预留功能）"
      >
        <Sparkles class="size-4" :stroke-width="1.75" />
      </button>
    </div>
  </div>
</template>
