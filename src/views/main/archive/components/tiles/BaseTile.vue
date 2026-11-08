<script setup lang="ts">
import { computed } from 'vue';
import { Check } from '@lucide/vue';
import type { TileData } from '../../types/tile';
import {
  getTilePixelDimensions,
  getTileSpan,
  GRID_GAP,
  GROUP_COLUMNS,
  UNIT_SIZE,
  useTileStore,
} from '@/stores/archive/stores/tileStore';

const props = defineProps<{
  tile: TileData;
  isDragging?: boolean;
  isDropTarget?: boolean;
  isPreview?: boolean;
  /** 是否有全画幅封面（由父组件 FileTile/FolderTile 传入，用于跳过 backdrop-blur） */
  hasCover?: boolean;
  /** 文件夹弹窗网格模式：改用 Archive 同款像素网格（内联 gridColumn/gridRow） */
  inFolderGrid?: boolean;
}>();

const emit = defineEmits<{
  (e: 'click', tile: TileData): void;
  (e: 'contextmenu', event: MouseEvent, tile: TileData): void;
  (e: 'dragstart', event: PointerEvent, tile: TileData, grabOffset: { x: number; y: number }): void;
}>();

const tileStore = useTileStore();

const isResizing = computed(() => tileStore.resizingTileId === props.tile.id);
const resizingSpan = computed(() => (isResizing.value ? tileStore.resizingTileSpan : null));

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
  if (props.inFolderGrid) {
    return {
      gridColumn: `span ${currentSpan.value.w} / span ${currentSpan.value.w}`,
      gridRow: `span ${currentSpan.value.h} / span ${currentSpan.value.h}`,
      width: `${dimensions.value.width}px`,
      height: `${dimensions.value.height}px`,
    };
  }
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

// O(1) lookup via Set (no Array.includes scanning)
const selectedSet = computed(() =>
  props.inFolderGrid ? tileStore.folderSelectedTileIdSet : tileStore.selectedTileIdSet,
);
const isSelected = computed(() => !props.isPreview && selectedSet.value.has(props.tile.id));

const isBatchDraggedMember = computed(
  () =>
    !props.inFolderGrid &&
    !props.isPreview &&
    tileStore.dragState.isDragging &&
    tileStore.selectedTileIds.length > 1 &&
    tileStore.selectedTileIdSet.has(props.tile.id) &&
    tileStore.dragState.tile &&
    tileStore.selectedTileIdSet.has(tileStore.dragState.tile.id),
);

/** 文件夹弹窗内正在被拖拽的源磁贴（内部重排模式），弱化显示 */
const isFolderDragSource = computed(
  () =>
    props.inFolderGrid &&
    !props.isPreview &&
    tileStore.folderDragState.isDragging &&
    tileStore.folderDragState.ids.includes(props.tile.id),
);

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

// 仅在拖拽动画 / 缩放期间开启 will-change，避免常驻数百个独立 GPU 合成层
const needsWillChange = computed(() =>
  !props.isPreview && (
    (props.inFolderGrid
      ? false
      : tileStore.dragState.isDragging && tileStore.dragState.currentGroupId === props.tile.groupId) ||
    isResizing.value
  ),
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
// 多选时：拖拽其中一个磁贴的右下角手柄，批量联动所有已选磁贴
function onResizerPointerDown(event: PointerEvent) {
  if (props.isPreview || event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();

  const startX = event.clientX;
  const startY = event.clientY;
  const initialSpan = getTileSpan(props.tile.size, props.tile.customSpan);
  tileStore.resizingTileId = props.tile.id;
  tileStore.resizingTileSpan = { ...initialSpan };

  const group = tileStore.groups.find((g) => g.id === props.tile.groupId);
  const maxCols = props.inFolderGrid ? 12 : (group?.widthColumns || GROUP_COLUMNS);
  const maxWidth = props.inFolderGrid ? maxCols : Math.max(1, maxCols - props.tile.x);

  const onPointerMove = (moveEvent: PointerEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    const deltaW = Math.round(dx / (UNIT_SIZE + GRID_GAP));
    const deltaH = Math.round(dy / (UNIT_SIZE + GRID_GAP));

    const newW = Math.max(1, Math.min(maxWidth, initialSpan.w + deltaW));
    const newH = Math.max(1, Math.min(6, initialSpan.h + deltaH));
    tileStore.resizingTileSpan = { w: newW, h: newH };
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    const activeSpan = tileStore.resizingTileSpan;
    if (activeSpan) {
      const { w, h } = activeSpan;
      const changed = w !== initialSpan.w || h !== initialSpan.h;
      if (changed) {
        const ids = props.inFolderGrid
          ? (tileStore.folderSelectedTileIds.length > 1 && tileStore.folderSelectedTileIdSet.has(props.tile.id)
              ? [...tileStore.folderSelectedTileIds] : [props.tile.id])
          : (tileStore.selectedTileIds.length > 1 && tileStore.selectedTileIdSet.has(props.tile.id)
              ? [...tileStore.selectedTileIds] : [props.tile.id]);
        if (ids.length > 1) tileStore.batchResizeTileSpan(ids, w, h);
        else tileStore.resizeTileSpan(props.tile.id, w, h);
      }
    }
    tileStore.resizingTileId = null;
    tileStore.resizingTileSpan = null;
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

function handleClick(event: MouseEvent) {
  if (props.isPreview || hasMoved || isResizing.value) return;
  if (event.shiftKey) {
    if (props.inFolderGrid) tileStore.toggleSelectFolderChildTile(props.tile.id, true);
    else tileStore.selectTileRange(props.tile.id);
    return;
  }
  if (event.ctrlKey || event.metaKey) {
    if (props.inFolderGrid) tileStore.toggleSelectFolderChildTile(props.tile.id, true);
    else tileStore.toggleSelectTile(props.tile.id, true);
    return;
  }
  if (props.inFolderGrid) {
    if (tileStore.folderSelectedTileIds.length > 0) tileStore.clearFolderSelectedTiles();
  } else if (tileStore.selectedTileIds.length > 0) {
    tileStore.clearSelectedTiles();
  }
  emit('click', props.tile);
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
    :data-board-tile-id="!inFolderGrid && !isPreview ? tile.id : undefined"
    :data-folder-tile-id="inFolderGrid && !isPreview ? tile.id : undefined"
    class="archive-base-tile select-none rounded-[2px]"
    :class="[
      inFolderGrid ? 'relative' : 'absolute top-0 left-0',
      isPreview ? 'pointer-events-none' : 'cursor-pointer transition-transform duration-220 ease-out',
      needsWillChange ? 'will-change-transform' : '',
      isDragging ? 'opacity-0 pointer-events-none' : '',
      isBatchDraggedMember && !isDragging ? 'opacity-30 scale-95 pointer-events-none' : '',
      isFolderDragSource ? 'opacity-30' : '',
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
        // 有全画幅封面时缩减毛玻璃开销；无封面时保留 backdrop-blur
        hasCover
          ? 'bg-[#0f172a]/70 border-white/20 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2),0_4px_14px_rgba(0,0,0,0.3)]'
          : 'backdrop-blur-md bg-[#0f172a]/70 border-white/20 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.2),0_4px_14px_rgba(0,0,0,0.3)]',
        'hover:border-white/40 hover:bg-[#1e293b]/80 hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.35),0_6px_20px_rgba(0,0,0,0.4)]',
        'active:scale-[0.98] active:bg-[#0f172a]/85',
        isSelected ? 'ring-2 ring-sky-400 border-sky-400 bg-sky-900/55 shadow-[0_0_16px_rgba(56,189,248,0.45)]' : '',
        isMergeReady || isFolderLocked ? 'ring-2 ring-sky-400 border-sky-400 bg-sky-950/85 shadow-[0_0_18px_rgba(56,189,248,0.6)]' : '',
        isFolderCandidate ? 'ring-1 ring-sky-400/50 bg-sky-950/35' : '',
        isMergeTarget && !isMergeReady && !isFolderDropTarget ? 'ring-1 ring-sky-400/40' : '',
        isResizing ? 'ring-2 ring-sky-400 border-sky-400' : '',
      ]"
    >
      <slot />

      <!-- 框选/多选右上角勾选角标 -->
      <button
        v-if="!isPreview && !tile.undeletable && !tile.systemApp"
        type="button"
        class="absolute right-1 top-1 z-30 flex size-4 items-center justify-center rounded-[2px] border transition-all"
        :class="
          isSelected
            ? 'border-sky-300 bg-sky-500 text-white opacity-100 shadow-sm'
            : 'border-white/30 bg-black/45 text-transparent opacity-0 group-hover:opacity-100 hover:border-sky-300'
        "
        title="点击切换多选 (Ctrl / Shift + 点击)"
        @pointerdown.stop
        @click.stop="
          inFolderGrid
            ? tileStore.toggleSelectFolderChildTile(tile.id, true)
            : tileStore.toggleSelectTile(tile.id, true)
        "
      >
        <Check class="size-2.5" :stroke-width="2.6" />
      </button>

      <!-- Drop hint: 锁定文件夹 / 合成文件夹 -->
      <div
        v-if="showDropHint"
        class="pointer-events-none absolute inset-x-1 bottom-1 z-30 truncate rounded bg-sky-500/90 px-1 py-0.5 text-center text-[10px] font-semibold text-white shadow"
      >
        {{ dropHintLabel }}
      </div>

      <!-- Resizing live dimension indicator badge -->
      <div
        v-if="isResizing && resizingSpan"
        class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-sky-950/60 font-mono font-bold text-xs text-sky-300 border border-dashed border-sky-400"
      >
        {{ resizingSpan.w }} × {{ resizingSpan.h }}
        <span
          v-if="inFolderGrid
            ? tileStore.folderSelectedTileIds.length > 1 && tileStore.folderSelectedTileIdSet.has(tile.id)
            : tileStore.selectedTileIds.length > 1 && tileStore.selectedTileIdSet.has(tile.id)"
          class="ml-1 text-sky-400/70"
        >(×{{ inFolderGrid ? tileStore.folderSelectedTileIds.length : tileStore.selectedTileIds.length }})</span>
      </div>

      <!-- Tile Bottom-Right Resize Grip Handle (Minimum grid unit stepping) -->
      <div
        v-if="!isPreview"
        class="opacity-0 group-hover:opacity-100 transition-opacity absolute right-0.5 bottom-0.5 size-4 z-40 cursor-nwse-resize flex items-end justify-end p-0.5 select-none"
        title="拖动调整磁贴大小；已多选时批量联动"
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
}
</style>
