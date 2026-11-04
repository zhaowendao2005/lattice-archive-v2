<script setup lang="ts">
import { CheckSquare, Loader2, Search, SearchX, Sparkles, Square } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import SearchResultCard from './SearchResultCard.vue';

const searchStore = useAggregateSearchStore();

</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- 结果流顶部状态与多选控制条 -->
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/[0.08] bg-white/[0.02] px-4 py-2 text-[11px]">
      <!-- 左侧：流式进度与命中统计 -->
      <div class="flex items-center gap-2 text-white/60">
        <span
          v-if="searchStore.isStreaming"
          class="flex items-center gap-1.5 text-sky-300"
        >
          <Loader2 class="size-3.5 animate-spin text-sky-400" />
          <span>正在流式推送搜索结果...</span>
        </span>
        <span v-else class="flex items-center gap-1.5">
          <Sparkles class="size-3 text-sky-400/80" />
          <span>
            已流式加载
            <strong class="font-mono text-white/90">{{ searchStore.displayedResults.length }}</strong>
            / 共命中
            <strong class="font-mono text-white/90">{{ searchStore.totalMatched }}</strong>
            项
          </span>
        </span>

        <span
          v-if="searchStore.selectedPreCategories.length > 0"
          class="rounded-[2px] border border-sky-400/35 bg-sky-500/15 px-1.5 py-0.2 text-[10px] text-sky-200"
        >
          搜索前类型：{{ searchStore.selectedPreCategories.length }} 类
        </span>
        <span
          v-if="searchStore.selectedScopeSessionIds.length > 0"
          class="rounded-[2px] border border-amber-400/35 bg-amber-500/15 px-1.5 py-0.2 text-[10px] text-amber-200"
        >
          会话范围：{{ searchStore.selectedScopeSessionIds.length }} 个会话
        </span>
        <span v-if="Object.keys(searchStore.peerProgress).length > 0" class="text-white/45">
          {{ searchStore.peerSummary.completed }} 个会话已完成
          · {{ searchStore.peerSummary.failed }} 个会话失败
        </span>
      </div>

      <!-- 右侧：多选提示与快捷全选/清空 -->
      <div class="flex items-center gap-2.5">
        <span
          class="font-mono text-[10px]"
          :class="
            searchStore.selectedResultIds.length > 0
              ? 'font-semibold text-sky-300'
              : 'text-white/40'
          "
        >
          {{
            searchStore.selectedResultIds.length > 0
              ? `已选 ${searchStore.selectedResultIds.length} 项（可向左拖入目录树）`
              : '单击选择 · Shift 连续多选'
          }}
        </span>

        <button
          type="button"
          class="flex items-center gap-1 text-white/55 transition-colors hover:text-white"
          @click="searchStore.selectAllDisplayedResults"
        >
          <CheckSquare class="size-3" />
          <span>全选</span>
        </button>

        <button
          type="button"
          class="flex items-center gap-1 text-white/45 transition-colors hover:text-white"
          @click="searchStore.clearResultSelection"
        >
          <Square class="size-3" />
          <span>清空选择</span>
        </button>
      </div>
    </div>

    <!-- 搜索错误与失败会话详情（沿用 HEAD 的红色警示风格） -->
    <p
      v-if="searchStore.searchError"
      role="alert"
      class="shrink-0 border-b border-rose-400/30 bg-rose-500/10 px-4 py-2 text-[11px] text-rose-200"
    >
      {{ searchStore.searchError }}
    </p>
    <details
      v-if="searchStore.failedPeers.length"
      class="shrink-0 border-b border-rose-400/30 bg-rose-500/10 px-4 py-2 text-[11px] text-rose-200"
    >
      <summary class="cursor-pointer">
        {{ searchStore.failedPeers.length }} 个会话失败，结果不完整（展开详情）
      </summary>
      <p v-for="peer in searchStore.failedPeers" :key="peer.peerKey" class="mt-1 font-mono text-[10px] text-rose-300">
        {{ peer.peerKey }} · {{ peer.errorCode }}
      </p>
    </details>

    <!-- 流式结果滚动容器（固定行高虚拟窗口：只挂载可视行与上下各 5 行） -->
    <div
      :ref="searchStore.bindResultsViewport"
      class="search-results-viewport search-modal-scroll min-h-0 flex-1 overflow-y-auto p-4 [overflow-anchor:none]"
      role="listbox"
      aria-label="聚焦搜索结果，支持多选及拖入左侧目录"
      aria-multiselectable="true"
    >
      <div :style="{ paddingTop: `${searchStore.virtualPaddingTop}px`, paddingBottom: `${searchStore.virtualPaddingBottom}px` }">
        <div
          v-for="(item, index) in searchStore.virtualResults"
          :key="item.id"
          class="pb-2"
          :style="{ height: `${searchStore.resultRowHeight}px` }"
        >
          <SearchResultCard
            :item="item"
            :index="searchStore.resultWindow.start + index"
            :selected="searchStore.selectedResultSet.has(item.id)"
          />
        </div>
      </div>

      <!-- 初始状态：打开窗口不会自动发起检索 -->
      <div
        v-if="!searchStore.hasSearched && !searchStore.isStreaming"
        class="my-auto flex flex-col items-center justify-center py-16 text-center"
      >
        <div
          class="flex size-12 items-center justify-center rounded-[2px] border border-white/10 bg-white/[0.03] text-white/35"
        >
          <Search class="size-6" :stroke-width="1.6" />
        </div>
        <p class="mt-3 text-xs font-medium text-white/75">输入关键词后按回车开始搜索</p>
        <p class="mt-1 text-[11px] text-white/40">
          打开窗口不会自动检索；可先在右侧选择会话范围与搜索前类型，再点击搜索
        </p>
      </div>

      <!-- 空状态 -->
      <div
        v-if="
          !searchStore.isStreaming &&
          searchStore.hasSearched &&
          searchStore.displayedResults.length === 0
        "
        class="my-auto flex flex-col items-center justify-center py-16 text-center"
      >
        <div
          class="flex size-12 items-center justify-center rounded-[2px] border border-white/10 bg-white/[0.03] text-white/35"
        >
          <SearchX class="size-6" :stroke-width="1.6" />
        </div>
        <p class="mt-3 text-xs font-medium text-white/75">
          {{
            searchStore.searchStatus === 'stopped'
              ? '已停止搜索，当前没有匹配结果'
              : searchStore.searchStatus === 'error' || searchStore.searchStatus === 'partial'
                ? '搜索未完整完成，请查看错误后重试'
                : '未找到符合当前筛选与会话范围的归档条目'
          }}
        </p>
        <p class="mt-1 text-[11px] text-white/40">
          可尝试放宽「搜索前文件类型」或右侧「会话范围控制」后重新点击搜索
        </p>
      </div>

      <!-- 底部流式加载状态 -->
      <div class="flex items-center justify-center py-3 text-[11px] text-white/40">
        <div
          v-if="searchStore.isStreaming"
          class="flex items-center gap-2 text-sky-300/85"
        >
          <Loader2 class="size-3.5 animate-spin text-sky-400" />
          <span>正在流式接收分片数据...</span>
        </div>
        <span v-else-if="searchStore.displayedResults.length > 0" class="font-mono text-[10px]">
          — 已流式加载全部 {{ searchStore.displayedResults.length }} 条匹配结果 —
        </span>
      </div>
    </div>
  </div>
</template>
