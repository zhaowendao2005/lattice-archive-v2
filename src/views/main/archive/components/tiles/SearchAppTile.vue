<script setup lang="ts">
import { Search, Sparkles } from '@lucide/vue';
import type { FileTileData } from '../../types/tile';
import BaseTile from './BaseTile.vue';

defineProps<{
  tile: FileTileData;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isPreview?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', tile: FileTileData): void;
  (e: 'contextmenu', event: MouseEvent, tile: FileTileData): void;
  (
    e: 'dragstart',
    event: PointerEvent,
    tile: FileTileData,
    grabOffset?: { x: number; y: number },
  ): void;
}>();
</script>

<template>
  <BaseTile
    :tile="tile"
    :is-dragging="isDragging"
    :is-drop-target="isDropTarget"
    :is-preview="isPreview"
    :title="`${tile.title} · 系统常驻应用`"
    @click="emit('click', tile)"
    @contextmenu="emit('contextmenu', $event, tile)"
    @dragstart="(event, _t, grabOffset) => emit('dragstart', event, tile, grabOffset)"
  >
    <!-- 1x1 Small Tile -->
    <div
      v-if="tile.size === 'small'"
      class="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-sky-500/25 via-sky-600/15 to-blue-900/25 p-1"
    >
      <Search
        class="size-6 text-sky-300 drop-shadow-[0_0_8px_rgba(56,189,248,0.45)] transition-transform duration-150 group-hover:scale-110"
        :stroke-width="2"
      />
    </div>

    <!-- 2x2 Medium Tile -->
    <div
      v-else-if="tile.size === 'medium'"
      class="relative flex h-full w-full flex-col justify-between bg-gradient-to-br from-sky-500/20 via-sky-600/10 to-blue-950/30 p-2"
    >
      <div class="flex items-center justify-between">
        <span class="h-1.5 w-1.5 rounded-full bg-sky-400 shadow-[0_0_6px_rgba(56,189,248,0.9)]" />
        <span
          class="rounded-[2px] border border-sky-400/30 bg-sky-500/15 px-1 py-0.5 font-mono text-[9px] tracking-wider text-sky-300"
        >
          APP
        </span>
      </div>

      <div class="flex flex-1 items-center justify-center">
        <div
          class="flex size-11 items-center justify-center rounded-[2px] border border-sky-400/30 bg-sky-500/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-transform duration-150 group-hover:scale-105 group-hover:border-sky-400/50"
        >
          <Search class="size-6 text-sky-300" :stroke-width="2" />
        </div>
      </div>

      <div class="min-w-0">
        <p class="truncate text-[11px] font-medium leading-tight text-white/95">
          {{ tile.title }}
        </p>
      </div>
    </div>

    <!-- 4x2 Wide Tile -->
    <div
      v-else-if="tile.size === 'wide'"
      class="relative flex h-full w-full items-center gap-3 bg-gradient-to-r from-sky-500/20 via-sky-600/10 to-blue-950/30 p-3"
    >
      <div
        class="flex size-12 shrink-0 items-center justify-center rounded-[2px] border border-sky-400/35 bg-sky-500/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)]"
      >
        <Search class="size-6 text-sky-300" :stroke-width="2" />
      </div>

      <div class="flex min-w-0 flex-1 flex-col justify-center">
        <div class="flex items-center gap-1.5">
          <span
            class="rounded-[2px] border border-sky-400/30 bg-sky-500/15 px-1 py-0.5 font-mono text-[9px] text-sky-300"
          >
            SEARCH
          </span>
          <p class="truncate text-xs font-medium text-white/95">
            {{ tile.title }}
          </p>
        </div>
        <p class="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/65">
          {{ tile.description || '多源会话流式检索与磁贴拓扑归档' }}
        </p>
      </div>
    </div>

    <!-- 4x4 Large Tile -->
    <div
      v-else
      class="relative flex h-full w-full flex-col justify-between bg-gradient-to-br from-sky-500/20 via-sky-900/15 to-slate-950/40 p-4"
    >
      <div class="flex items-center justify-between">
        <span
          class="flex items-center gap-1 rounded-[2px] border border-sky-400/30 bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-sky-300"
        >
          <Sparkles class="size-2.5" />
          <span>SYSTEM APP</span>
        </span>
        <span class="font-mono text-[10px] text-white/45">常驻</span>
      </div>

      <div class="my-auto flex flex-col items-center justify-center text-center">
        <div
          class="flex size-16 items-center justify-center rounded-[2px] border border-sky-400/35 bg-sky-500/15 shadow-[0_0_24px_rgba(56,189,248,0.25)]"
        >
          <Search class="size-9 text-sky-300" :stroke-width="1.9" />
        </div>
        <h3 class="mt-3 text-sm font-semibold text-white/95">
          {{ tile.title }}
        </h3>
        <p class="mt-1 max-w-[190px] line-clamp-3 text-xs leading-relaxed text-white/70">
          {{ tile.description || '跨会话多源流式检索，支持直接拖拽归入磁贴目录树' }}
        </p>
      </div>

      <div class="flex items-center justify-between text-[11px] text-sky-300/80">
        <span>流式引擎就绪</span>
        <span class="font-mono text-[10px] text-white/45">ENTER</span>
      </div>
    </div>
  </BaseTile>
</template>
