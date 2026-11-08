<script setup lang="ts">
import { Database, ShieldCheck } from '@lucide/vue';
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
      class="relative flex h-full w-full items-center justify-center bg-gradient-to-br from-teal-500/25 via-emerald-600/15 to-slate-900/25 p-1.5"
    >
      <Database
        class="size-7 text-teal-300 drop-shadow-[0_0_8px_rgba(45,212,191,0.45)] transition-transform duration-150 group-hover:scale-110"
        :stroke-width="2"
      />
    </div>

    <!-- 3x3 Medium / Wide Tile -->
    <div
      v-else-if="tile.size === 'medium' || tile.size === 'wide'"
      class="relative flex h-full w-full flex-col justify-between bg-gradient-to-br from-teal-500/20 via-emerald-600/10 to-slate-950/35 p-2.5"
    >
      <div class="flex items-center justify-between">
        <span class="h-1.5 w-1.5 rounded-full bg-teal-400 shadow-[0_0_6px_rgba(45,212,191,0.9)]" />
        <span
          class="rounded-[2px] border border-teal-400/30 bg-teal-500/15 px-1 py-0.5 font-mono text-[9px] tracking-wider text-teal-300"
        >
          HUB
        </span>
      </div>

      <div class="flex flex-1 items-center justify-center">
        <div
          class="flex size-12 items-center justify-center rounded-[2px] border border-teal-400/30 bg-teal-500/15 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2)] transition-transform duration-150 group-hover:scale-105 group-hover:border-teal-400/50"
        >
          <Database class="size-6 text-teal-300" :stroke-width="2" />
        </div>
      </div>

      <div class="min-w-0">
        <p class="truncate text-[11px] font-medium leading-tight text-white/95">
          {{ tile.title }}
        </p>
      </div>
    </div>

    <!-- 4x4 Large Tile -->
    <div
      v-else
      class="relative flex h-full w-full flex-col justify-between bg-gradient-to-br from-teal-500/20 via-emerald-900/15 to-slate-950/40 p-3.5"
    >
      <div class="flex items-center justify-between">
        <span
          class="flex items-center gap-1 rounded-[2px] border border-teal-400/30 bg-teal-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-teal-300"
        >
          <ShieldCheck class="size-2.5" />
          <span>SYSTEM APP</span>
        </span>
        <span class="font-mono text-[10px] text-white/45">常驻</span>
      </div>

      <div class="my-auto flex flex-col items-center justify-center text-center">
        <div
          class="flex size-16 items-center justify-center rounded-[2px] border border-teal-400/35 bg-teal-500/15 shadow-[0_0_24px_rgba(45,212,191,0.25)]"
        >
          <Database class="size-9 text-teal-300" :stroke-width="1.9" />
        </div>
        <h3 class="mt-3 text-sm font-semibold text-white/95">
          {{ tile.title }}
        </h3>
        <p class="mt-1 max-w-[190px] line-clamp-3 text-xs leading-relaxed text-white/70">
          {{ tile.description || '统一管理已加入会话、临时凭据池、多账号槽位矩阵、智能配额与保险库' }}
        </p>
      </div>

      <div class="flex items-center justify-between text-[11px] text-teal-300/80">
        <span>治理中心就绪</span>
        <span class="font-mono text-[10px] text-white/45">ENTER</span>
      </div>
    </div>
  </BaseTile>
</template>
