<script setup lang="ts">
import { computed, onUnmounted } from 'vue';
import { Check, CheckCircle2, GripVertical, KeyRound, RefreshCw, Sparkles, Users } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import type { AggregateSearchResultItem } from '@/stores/archive/types';
import { useTileStore } from '@/stores/archive/stores/tileStore';

const props = defineProps<{
  item: AggregateSearchResultItem;
  index: number;
  selected: boolean;
}>();

const searchStore = useAggregateSearchStore();
const tileStore = useTileStore();

const archivedLocation = computed(() => tileStore.archivedSourceMap.get(props.item.id) || null);
const isLoadingHd = computed(() => Boolean(searchStore.loadingHighResIds[props.item.id]));
const isHdLoaded = computed(() => Boolean(props.item.hdThumbLoaded || searchStore.highResLoadedIds[props.item.id]));
/** 纯文本消息没有可下载媒体，不展示「加载高清」入口，避免点击后无任何反应。 */
const canLoadHd = computed(() => {
  if (props.item.category === 'session') return true;
  return Boolean(props.item.photoInfo || props.item.videoInfo || props.item.fileInfo?.preview);
});
const showThumb = computed(
  () => Boolean(props.item.thumbnailUrl) && !searchStore.brokenThumbIds[props.item.id],
);

function handleThumbClick(event: MouseEvent) {
  event.stopPropagation();
  if (!canLoadHd.value) return;
  void searchStore.loadHighResThumbnailForItem(props.item);
}

function handleThumbError() {
  searchStore.markThumbBroken(props.item, props.item.thumbnailUrl);
}

/** 拖动文字区域滚动条不应启动跨栏拖拽，只有点在内容区域才交给手势。 */
function isScrollbarHit(event: MouseEvent | PointerEvent): boolean {
  const scroller = (event.target as HTMLElement).closest<HTMLElement>('.search-row-scroll');
  return Boolean(scroller && event.clientX > scroller.getBoundingClientRect().left + scroller.clientWidth);
}

function onCardPointerDown(event: PointerEvent) {
  if (isScrollbarHit(event)) return;
  searchStore.startResultPointerGesture(props.item, event);
}

function onCardClick(event: MouseEvent) {
  if (isScrollbarHit(event)) return;
  searchStore.handleResultCardClick(props.index, props.item, event);
}

// 拖拽手势（指针监听、阈值、拖拽后吞掉误触 click）由 Store 经 searchResultGestureDataSource 管理。
onUnmounted(() => searchStore.releaseResultGesture(props.item.id));
</script>

<template>
  <article
    class="group relative flex h-full cursor-grab select-none items-center gap-3 rounded-[2px] border p-2.5 transition-all duration-150 active:cursor-grabbing"
    :class="
      selected
        ? 'border-sky-400/85 bg-sky-500/[0.17] ring-1 ring-sky-400/55 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.28),0_6px_18px_-6px_rgba(14,165,233,0.3)]'
        : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
    "
    role="option"
    :aria-selected="selected"
    tabindex="0"
    @pointerdown="onCardPointerDown"
    @click="onCardClick"
    @keydown.enter.prevent="searchStore.handleResultCardClick(index, item, $event)"
    @keydown.space.prevent="searchStore.handleResultCardClick(index, item, $event)"
  >
    <!-- 左端：正方形缩略图容器 (Square Thumbnail，支持单独点击加载高清缩略图) -->
    <div
      class="group/thumb relative aspect-square size-14 shrink-0 cursor-pointer overflow-hidden rounded-[2px] border border-white/12 bg-black/45 transition-colors hover:border-sky-400/60"
      :title="
        isHdLoaded
          ? '已加载高清缩略图（点击重新加载）'
          : canLoadHd
            ? '点击单独加载高清缩略图'
            : '该结果没有可用的缩略图'
      "
      @pointerdown.stop
      @click="handleThumbClick"
    >
      <img
        v-if="showThumb"
        :src="item.thumbnailUrl"
        :alt="item.title"
        loading="lazy"
        class="h-full w-full object-cover transition-transform duration-200 group-hover/thumb:scale-105"
        @error="handleThumbError"
      />
      <div
        v-else
        class="flex h-full w-full items-center justify-center bg-slate-900/80 font-mono text-[10px] font-semibold uppercase text-white/45"
      >
        {{ item.extension || 'FILE' }}
      </div>

      <!-- 悬浮提示：点击加载高清（仅对有媒体的结果展示） -->
      <div
        v-if="canLoadHd && !isLoadingHd && !isHdLoaded"
        class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center bg-black/55 opacity-0 transition-opacity duration-150 group-hover/thumb:opacity-100"
      >
        <Sparkles class="size-3.5 text-sky-300" />
        <span class="mt-0.5 font-mono text-[8px] font-medium text-sky-200">加载高清</span>
      </div>

      <!-- 加载中遮罩 -->
      <div
        v-if="isLoadingHd"
        class="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/65 backdrop-blur-[1px]"
      >
        <RefreshCw class="size-4 animate-spin text-sky-300" />
      </div>

      <!-- 已加载高清 HD 徽标 -->
      <span
        v-if="isHdLoaded && !isLoadingHd"
        class="pointer-events-none absolute left-0.5 top-0.5 rounded-[1px] bg-sky-500/85 px-1 py-0.2 font-mono text-[8px] font-bold text-slate-950 shadow-xs"
      >
        HD
      </span>

      <!-- 缩略图底部胶囊角标 -->
      <span
        class="pointer-events-none absolute bottom-0.5 right-0.5 rounded-[1px] bg-black/75 px-1 py-0.2 font-mono text-[9px] text-white/85 backdrop-blur-xs"
      >
        {{ item.badgeMeta }}
      </span>
    </div>

    <!-- 右侧：Title 与结构化元数据 -->
    <div class="search-row-scroll min-h-0 min-w-0 flex-1 self-stretch overflow-y-auto">
      <!-- 第一行：Title + 类型标签 + 归档状态 -->
      <div class="flex items-center gap-2">
        <h3
          class="min-w-0 flex-1 truncate text-[13px] font-medium tracking-wide"
          :class="selected ? 'text-white' : 'text-white/92'"
        >
          {{ item.title }}
        </h3>

        <!-- 已在磁贴拓扑中的实时标记 -->
        <span
          v-if="archivedLocation"
          class="flex shrink-0 items-center gap-1 rounded-[2px] border border-emerald-400/40 bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300"
          :title="`已归入：${archivedLocation}`"
        >
          <CheckCircle2 class="size-2.5" />
          <span class="max-w-[120px] truncate">{{ archivedLocation }}</span>
        </span>

        <!-- 文件类型标签 -->
        <span
          v-if="item.groupedId"
          class="shrink-0 rounded-[2px] border border-sky-400/40 bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-300"
          title="相册套图 (groupedId)"
        >
          📚 套图
        </span>
        <span
          v-if="item.noforwards"
          class="shrink-0 rounded-[2px] border border-amber-400/40 bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300"
          title="源群组开启了防转发保护 (noforwards)，归档时将启用本地流式代理克隆"
        >
          🔒 受限
        </span>
        <span
          class="shrink-0 rounded-[2px] border border-white/12 bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-white/75"
        >
          {{ item.categoryLabel }}
        </span>
      </div>

      <!-- 第二行：内容摘要 -->
      <p class="mt-1 truncate text-[11px] text-white/55">
        {{ item.snippet }}
      </p>

      <!-- 第三行：来源会话（区分「已加入」与「只有凭据」）、大小、时间 -->
      <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] text-white/40">
        <span class="flex items-center gap-1 text-white/60">
          <KeyRound
            v-if="item.sessionKind === 'credential_only'"
            class="size-2.5 text-amber-300"
          />
          <Users v-else class="size-2.5 text-sky-300" />
          <span class="max-w-[180px] truncate">{{ item.sessionTitle }}</span>
          <span
            class="rounded-[1px] px-1 text-[9px]"
            :class="
              item.sessionKind === 'credential_only'
                ? 'bg-amber-500/20 text-amber-300'
                : 'bg-sky-500/15 text-sky-300'
            "
          >
            {{ item.sessionKind === 'credential_only' ? '仅凭据' : '已加入' }}
          </span>
        </span>

        <span>{{ item.fileSize }}</span>
        <span class="uppercase">{{ item.extension }}</span>
        <span>{{ item.updatedAt }}</span>
      </div>
    </div>

    <!-- 右端：拖拽把手提示与多选高亮勾选框 -->
    <div class="flex shrink-0 items-center gap-1.5 pl-1">
      <GripVertical
        class="size-3.5 text-white/20 opacity-0 transition-opacity group-hover:opacity-100"
      />
      <div
        class="flex size-4 items-center justify-center rounded-[2px] border transition-colors"
        :class="
          selected
            ? 'border-sky-400 bg-sky-400 text-slate-950 shadow-[0_0_8px_rgba(56,189,248,0.6)]'
            : 'border-white/20 bg-black/35 text-transparent group-hover:border-white/40'
        "
      >
        <Check class="size-3" :stroke-width="2.5" />
      </div>
    </div>
  </article>
</template>
