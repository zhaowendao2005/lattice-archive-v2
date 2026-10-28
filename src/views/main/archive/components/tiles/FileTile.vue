<script setup lang="ts">
import { computed } from 'vue';
import type { FileTileData } from '../../types/tile';
import BaseTile from './BaseTile.vue';
import { getFileVisual } from './fileVisuals';

const props = defineProps<{
  file: FileTileData;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isPreview?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', file: FileTileData): void;
  (e: 'contextmenu', event: MouseEvent, file: FileTileData): void;
  (e: 'dragstart', event: PointerEvent, file: FileTileData, grabOffset?: { x: number; y: number }): void;
}>();

const currentConfig = computed(() => getFileVisual(props.file.fileType));

const extBadge = computed(() => {
  return props.file.extension ? props.file.extension.toUpperCase() : currentConfig.value.badge;
});
</script>

<template>
  <BaseTile
    :tile="file"
    :is-dragging="isDragging"
    :is-drop-target="isDropTarget"
    :is-preview="isPreview"
    :title="file.title"
    @click="emit('click', file)"
    @contextmenu="emit('contextmenu', $event, file)"
    @dragstart="(event, _tile, grabOffset) => emit('dragstart', event, file, grabOffset)"
  >
    <!-- 1x1 Small Tile -->
    <div
      v-if="file.size === 'small'"
      class="flex h-full w-full items-center justify-center p-1"
      :class="currentConfig.tint"
    >
      <component
        :is="currentConfig.icon"
        class="size-6 transition-transform duration-150 group-hover:scale-110"
        :class="currentConfig.color"
        :stroke-width="1.8"
      />
    </div>

    <!-- 2x2 Medium Tile (Classic Win10 Live Tile) -->
    <div
      v-else-if="file.size === 'medium'"
      class="flex h-full w-full flex-col justify-between p-2"
      :class="currentConfig.tint"
    >
      <div class="flex items-start justify-end">
        <span class="rounded-sm bg-white/10 px-1 py-0.5 text-[9px] font-mono tracking-wider text-white/60">
          {{ extBadge }}
        </span>
      </div>

      <div class="flex flex-1 items-center justify-center">
        <component
          :is="currentConfig.icon"
          class="size-8 transition-transform duration-150 group-hover:scale-105"
          :class="currentConfig.color"
          :stroke-width="1.8"
        />
      </div>

      <div class="min-w-0">
        <p class="truncate text-[11px] font-normal leading-tight text-white/95">
          {{ file.title }}
        </p>
      </div>
    </div>

    <!-- 4x2 Wide Tile -->
    <div
      v-else-if="file.size === 'wide'"
      class="flex h-full w-full items-center gap-3 p-3"
      :class="currentConfig.tint"
    >
      <div class="flex size-12 shrink-0 items-center justify-center rounded-sm bg-white/10">
        <component
          :is="currentConfig.icon"
          class="size-7"
          :class="currentConfig.color"
          :stroke-width="1.8"
        />
      </div>

      <div class="flex min-w-0 flex-1 flex-col justify-center">
        <div class="flex items-center gap-1.5">
          <span class="rounded-sm bg-white/10 px-1 py-0.5 text-[9px] font-mono text-white/60">
            {{ extBadge }}
          </span>
          <p class="truncate text-xs font-medium text-white/95">
            {{ file.title }}
          </p>
        </div>
        <p v-if="file.description" class="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/65">
          {{ file.description }}
        </p>
      </div>
    </div>

    <!-- 4x4 Large Tile -->
    <div
      v-else
      class="flex h-full w-full flex-col justify-between p-4"
      :class="currentConfig.tint"
    >
      <div class="flex items-center justify-between">
        <span class="rounded-sm bg-white/15 px-1.5 py-0.5 text-[10px] font-mono font-medium text-white/80">
          {{ extBadge }}
        </span>
        <span class="text-[10px] text-white/50">{{ file.updatedAt }}</span>
      </div>

      <div class="my-auto flex flex-col items-center justify-center text-center">
        <component
          :is="currentConfig.icon"
          class="size-12"
          :class="currentConfig.color"
          :stroke-width="1.8"
        />
        <h3 class="mt-2 text-sm font-semibold text-white/95">
          {{ file.title }}
        </h3>
        <p v-if="file.description" class="mt-1 max-w-[190px] line-clamp-3 text-xs leading-relaxed text-white/70">
          {{ file.description }}
        </p>
      </div>

      <div class="text-[11px] text-white/60">
        {{ file.tags?.join(' · ') || '已归档' }}
      </div>
    </div>
  </BaseTile>
</template>
