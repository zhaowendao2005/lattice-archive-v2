<script setup lang="ts">
import { computed, ref } from 'vue';
import type { TileData } from '../../types/tile';
import {
  getTilePixelDimensions,
  getTileSpan,
  GRID_GAP,
  GROUP_COLUMNS,
  UNIT_SIZE,
  useTileStore,
} from '../../store/tileStore';
import { computeDisplacedPositions } from '../../utils/layoutEngine';

const props = defineProps<{
  tile: TileData;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isPreview?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', tile: TileData): void;
  (e: 'contextmenu', event: MouseEvent, tile: TileData): void;
  (e: 'dragstart', event: PointerEvent, tile: TileData, grabOffset: { x: number; y: number }): void;
}>();

const tileStore = useTileStore();

// Live resizing state
const isResizing = ref(false);
const resizingSpan = ref<{ w: number; h: number } | null>(null);

const currentSpan = computed(() => {
  if (isResizing.value && resizingSpan.value) {
    return resizingSpan.value;
  }
  return getTileSpan(props.tile.size, props.tile.customSpan);
});

const dimensions = computed(() => getTilePixelDimensions(props.tile.size, currentSpan.value));

// Use displaced position during active drag so tiles slide smoothly into gaps
const displayCoords = computed(() => {
  if (props.isPreview) {
    return { x: 0, y: 0 };
  }
  if (
    tileStore.dragState.isDragging &&
    tileStore.dragState.currentGroupId === props.tile.groupId &&
    tileStore.dragState.displacedPositions[props.tile.id]
  ) {
    return tileStore.dragState.displacedPositions[props.tile.id];
  }
  return { x: props.tile.x, y: props.tile.y };
});

const positionStyle = computed(() => {
  if (props.isPreview) {
    return {
      width: '100%',
      height: '100%',
      top: '0px',
      left: '0px',
      transform: 'none',
    };
  }
  const left = displayCoords.value.x * (UNIT_SIZE + GRID_GAP);
  const top = displayCoords.value.y * (UNIT_SIZE + GRID_GAP);
  return {
    width: `${dimensions.value.width}px`,
    height: `${dimensions.value.height}px`,
    top: '0px',
    left: '0px',
    transform: `translate3d(${left}px, ${top}px, 0)`,
  };
});

const isMergeTarget = computed(() => {
  return (
    !props.isPreview &&
    tileStore.dragState.isDragging &&
    tileStore.dragState.hoverTargetTileId === props.tile.id
  );
});

const isMergeReady = computed(() => {
  return isMergeTarget.value && tileStore.dragState.isMergeReady;
});

// 文件夹意图：候选（只描边） / 锁定（可落入）
const isFolderDropTarget = computed(() => {
  return isMergeTarget.value && props.tile.type === 'folder';
});

const isFolderCandidate = computed(
  () => isFolderDropTarget.value && tileStore.dragState.hoverPhase === 'candidate',
);

const isFolderLocked = computed(
  () => isFolderDropTarget.value && tileStore.dragState.hoverPhase === 'locked',
);

const showDropHint = computed(() => isMergeReady.value || isFolderLocked.value);

const dropHintLabel = computed(() =>
  props.tile.type === 'folder' ? `移入 · ${props.tile.title}` : '合成文件夹',
);

let pointerDownPos: { x: number; y: number } | null = null;
let tileStartRect: DOMRect | null = null;
let hasMoved = false;

function onPointerDown(event: PointerEvent) {
  if (props.isPreview || isResizing.value || event.button !== 0) return;
  pointerDownPos = { x: event.clientX, y: event.clientY };
  hasMoved = false;

  const targetEl = (event.currentTarget as HTMLElement) || (event.target as HTMLElement)?.closest('.archive-base-tile');
  tileStartRect = targetEl ? targetEl.getBoundingClientRect() : null;

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (!pointerDownPos) return;
    const dx = Math.abs(moveEvent.clientX - pointerDownPos.x);
    const dy = Math.abs(moveEvent.clientY - pointerDownPos.y);
    if (dx > 4 || dy > 4) {
      hasMoved = true;
      cleanup();
      const grabOffset = tileStartRect
        ? {
            x: pointerDownPos.x - tileStartRect.left,
            y: pointerDownPos.y - tileStartRect.top,
          }
        : {
            x: dimensions.value.width / 2,
            y: dimensions.value.height / 2,
          };
      emit('dragstart', moveEvent, props.tile, grabOffset);
    }
  };

  const onPointerUp = () => {
    cleanup();
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
}

// Drag handle to resize tile by minimum units
function onResizerPointerDown(event: PointerEvent) {
  if (props.isPreview || event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  const initialSpan = getTileSpan(props.tile.size, props.tile.customSpan);
  isResizing.value = true;
  resizingSpan.value = { ...initialSpan };

  const group = tileStore.groups.find(g => g.id === props.tile.groupId);
  const maxCols = group?.widthColumns || GROUP_COLUMNS;

  const onPointerMove = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    const deltaW = Math.round(dx / (UNIT_SIZE + GRID_GAP));
    const deltaH = Math.round(dy / (UNIT_SIZE + GRID_GAP));

    const newW = Math.max(1, Math.min(maxCols - props.tile.x, initialSpan.w + deltaW));
    const newH = Math.max(1, Math.min(6, initialSpan.h + deltaH));
    resizingSpan.value = { w: newW, h: newH };
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    if (resizingSpan.value) {
      const { w, h } = resizingSpan.value;
      if (w !== initialSpan.w || h !== initialSpan.h) {
        tileStore.resizeTileSpan(props.tile.id, w, h);
        const groupTiles = tileStore.tilesByGroup.get(props.tile.groupId) || [];
        const displaced = computeDisplacedPositions(groupTiles, props.tile, props.tile.x, props.tile.y, maxCols);
        tileStore.applyDisplacedPositions(props.tile.groupId, displaced);
      }
    }
    isResizing.value = false;
    resizingSpan.value = null;
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function handleClick() {
  if (!props.isPreview && !hasMoved && !isResizing.value) {
    emit('click', props.tile);
  }
}

function onContextMenu(event: MouseEvent) {
  if (props.isPreview || isResizing.value) return;
  event.preventDefault();
  event.stopPropagation();
  emit('contextmenu', event, props.tile);
}
</script>

<template>
  <div
    class="archive-base-tile absolute top-0 left-0 select-none rounded-[2px]"
    :class="[
      isPreview ? 'pointer-events-none' : 'cursor-pointer transition-transform duration-220 ease-out',
      isDragging ? 'opacity-0 pointer-events-none' : '',
      isMergeReady || isFolderLocked ? 'z-30 scale-105' : isFolderCandidate ? 'z-20 scale-[1.01]' : isMergeTarget ? 'z-20' : '',
      isResizing ? 'z-30 transition-none' : '',
    ]"
    :style="positionStyle"
    @pointerdown="onPointerDown"
    @click="handleClick"
    @contextmenu="onContextMenu"
  >
    <div
      class="group relative h-full w-full overflow-hidden rounded-[2px] border transition-all duration-150"
      :class="[
        // High quality Windows 10 Fluent Acrylic frosted glass
        'backdrop-blur-xl bg-[#0f172a]/70 border-white/20 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2),0_4px_14px_rgba(0,0,0,0.3)]',
        'hover:border-white/40 hover:bg-[#1e293b]/80 hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35),0_6px_20px_rgba(0,0,0,0.4)]',
        'active:scale-[0.98] active:bg-[#0f172a]/85',
        isMergeReady || isFolderLocked ? 'ring-2 ring-sky-400 border-sky-400 bg-sky-950/85 shadow-[0_0_18px_rgba(56,189,248,0.6)]' : '',
        isFolderCandidate ? 'ring-1 ring-sky-400/50 bg-sky-950/35' : '',
        isMergeTarget && !isMergeReady && !isFolderDropTarget ? 'ring-1 ring-sky-400/40' : '',
        isResizing ? 'ring-2 ring-sky-400 border-sky-400' : '',
      ]"
    >
      <slot />

      <!-- Drop hint: 锁定文件夹 / 合成文件夹 -->
      <div
        v-if="showDropHint"
        class="pointer-events-none absolute inset-x-1 bottom-1 z-30 truncate rounded bg-sky-500/90 px-1 py-0.5 text-center text-[10px] font-semibold text-white shadow backdrop-blur-sm"
      >
        {{ dropHintLabel }}
      </div>

      <!-- Resizing live dimension indicator badge -->
      <div
        v-if="isResizing && resizingSpan"
        class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-sky-950/60 backdrop-blur-xs font-mono font-bold text-xs text-sky-300 border border-dashed border-sky-400"
      >
        {{ resizingSpan.w }} × {{ resizingSpan.h }}
      </div>

      <!-- Tile Bottom-Right Resize Grip Handle (Minimum grid unit stepping) -->
      <div
        v-if="!isPreview"
        class="opacity-0 group-hover:opacity-100 transition-opacity absolute right-0.5 bottom-0.5 size-4 z-40 cursor-nwse-resize flex items-end justify-end p-0.5 select-none"
        title="拖动调整磁贴大小 (最小格单位)"
        @pointerdown="onResizerPointerDown"
      >
        <svg class="size-2.5 text-white/40 hover:text-white transition-colors" viewBox="0 0 6 6" fill="currentColor">
          <circle cx="5" cy="5" r="0.75" />
          <circle cx="2.5" cy="5" r="0.75" />
          <circle cx="5" cy="2.5" r="0.75" />
        </svg>
      </div>
    </div>
  </div>
</template>

<style scoped>
.archive-base-tile {
  touch-action: none;
  will-change: transform;
}
</style>
