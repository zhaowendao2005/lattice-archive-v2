<script setup lang="ts">
import { computed } from 'vue';
import { Check, CheckCircle2, GripVertical, KeyRound, Users } from '@lucide/vue';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import type { AggregateSearchResultItem } from '@/stores/archive/types';
import { useTileStore } from '../../../store/tileStore';

const props = defineProps<{
  item: AggregateSearchResultItem;
  index: number;
  selected: boolean;
}>();

const searchStore = useAggregateSearchStore();
const tileStore = useTileStore();

const archivedLocation = computed(() => tileStore.archivedSourceMap.get(props.item.id) || null);

let suppressNextClick = false;

function handleCardClick(event: MouseEvent) {
  if (suppressNextClick) {
    suppressNextClick = false;
    return;
  }
  searchStore.handleResultCardClick(props.index, props.item, event);
}

function onCardPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const startX = event.clientX;
  const startY = event.clientY;
  let dragStarted = false;

  const cleanup = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  };

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (!dragStarted) {
      if (
        Math.abs(moveEvent.clientX - startX) < 5 &&
        Math.abs(moveEvent.clientY - startY) < 5
      ) {
        return;
      }
      dragStarted = true;
      suppressNextClick = true;
      window.setTimeout(() => {
        suppressNextClick = false;
      }, 0);
      searchStore.startDragResultsToTree(props.item, moveEvent.clientX, moveEvent.clientY);
    }
    searchStore.updateDragToTreePointer(moveEvent.clientX, moveEvent.clientY);
  };

  const onPointerUp = () => {
    cleanup();
    if (dragStarted) {
      searchStore.finishDragToTree();
    }
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}
</script>

<template>
  <article
    class="group relative flex cursor-grab select-none items-center gap-3 rounded-[2px] border p-2.5 transition-all duration-150 active:cursor-grabbing"
    :class="
      selected
        ? 'border-sky-400/85 bg-sky-500/[0.17] ring-1 ring-sky-400/55 shadow-[inset_0_1px_0_0_rgba(56,189,248,0.28),0_6px_18px_-6px_rgba(14,165,233,0.3)]'
        : 'border-white/10 bg-white/[0.03] hover:border-white/25 hover:bg-white/[0.06]'
    "
    @pointerdown="onCardPointerDown"
    @click="handleCardClick"
  >
    <!-- 左端：正方形缩略图容器 (Square Thumbnail) -->
    <div
      class="relative aspect-square size-14 shrink-0 overflow-hidden rounded-[2px] border border-white/12 bg-black/45"
    >
      <img
        :src="item.thumbnailUrl"
        :alt="item.title"
        loading="lazy"
        class="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
      />
      <!-- 缩略图底部胶囊角标 -->
      <span
        class="absolute bottom-0.5 right-0.5 rounded-[1px] bg-black/75 px-1 py-0.2 font-mono text-[9px] text-white/85 backdrop-blur-xs"
      >
        {{ item.badgeMeta }}
      </span>
    </div>

    <!-- 右侧：Title 与结构化元数据 -->
    <div class="min-w-0 flex-1">
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
