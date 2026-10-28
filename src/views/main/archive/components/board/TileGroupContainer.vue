<script setup lang="ts">
import { computed, ref } from 'vue';
import { GripVertical, Pencil, Plus } from '@lucide/vue';
import type { TileData, TileGroupData } from '../../types/tile';
import {
  getTilePixelDimensions,
  getTileSpan,
  GRID_GAP,
  GROUP_COLUMNS,
  UNIT_SIZE,
  useTileStore,
} from '../../store/tileStore';
import FileTile from '../tiles/FileTile.vue';
import FolderTile from '../tiles/FolderTile.vue';

const props = defineProps<{
  group: TileGroupData;
  tiles: TileData[];
}>();

const emit = defineEmits<{
  (e: 'dragstart', event: PointerEvent, tile: TileData, grabOffset?: { x: number; y: number }): void;
  (e: 'group-drag-start', event: PointerEvent, group: TileGroupData): void;
}>();

const tileStore = useTileStore();
const groupGridRef = ref<HTMLElement | null>(null);
const isEditingTitle = ref(false);
const titleVal = ref(props.group.title);

// Width resizing state
const isResizingWidth = ref(false);
const liveWidthCols = ref<number | null>(null);

const groupColumns = computed(() => props.group.widthColumns || GROUP_COLUMNS);
const currentCols = computed(() => (isResizingWidth.value && liveWidthCols.value) ? liveWidthCols.value : groupColumns.value);

function saveTitle() {
  if (titleVal.value.trim()) {
    tileStore.renameGroup(props.group.id, titleVal.value.trim());
  }
  isEditingTitle.value = false;
}

// Compute total height needed by tiles in this group
const canvasHeight = computed(() => {
  let maxUnits = 4;
  for (const t of props.tiles) {
    const span = getTileSpan(t.size, t.customSpan);
    const disp =
      tileStore.dragState.isDragging &&
      tileStore.dragState.currentGroupId === props.group.id &&
      tileStore.dragState.displacedPositions[t.id];
    const y = disp ? disp.y : t.y;
    const bottom = y + span.h;
    if (bottom > maxUnits) maxUnits = bottom;
  }
  // If ghost is inside this group, account for ghost bottom
  if (
    tileStore.dragState.isDragging &&
    tileStore.dragState.currentGroupId === props.group.id &&
    tileStore.dragState.tile
  ) {
    const span = getTileSpan(tileStore.dragState.tile.size, tileStore.dragState.tile.customSpan);
    const ghostBottom = tileStore.dragState.ghostY + span.h;
    if (ghostBottom > maxUnits) maxUnits = ghostBottom;
  }

  // When dragging, allocate 2 extra rows of grid units to allow smooth downward embedding
  if (tileStore.dragState.isDragging) {
    maxUnits += 2;
  }

  return maxUnits * (UNIT_SIZE + GRID_GAP) + 12;
});

const totalRows = computed(() => {
  return Math.max(4, Math.ceil(canvasHeight.value / (UNIT_SIZE + GRID_GAP)));
});

const canvasWidth = computed(() => {
  return currentCols.value * UNIT_SIZE + (currentCols.value - 1) * GRID_GAP;
});

// Ghost dimension and position
const ghostStyle = computed(() => {
  if (
    !tileStore.dragState.isDragging ||
    tileStore.dragState.currentGroupId !== props.group.id ||
    !tileStore.dragState.tile ||
    // 锁定文件夹时隐藏 ghost，由目标磁贴高亮接管；候选时保留但弱化
    tileStore.dragState.hoverPhase === 'locked'
  ) {
    return null;
  }

  const dimensions = getTilePixelDimensions(tileStore.dragState.tile.size, tileStore.dragState.tile.customSpan);
  const left = tileStore.dragState.ghostX * (UNIT_SIZE + GRID_GAP);
  const top = tileStore.dragState.ghostY * (UNIT_SIZE + GRID_GAP);

  return {
    width: `${dimensions.width}px`,
    height: `${dimensions.height}px`,
    top: '0px',
    left: '0px',
    transform: `translate3d(${left}px, ${top}px, 0)`,
  };
});

function handleTileClick(tile: TileData) {
  if (tile.type === 'file') {
    tileStore.openFile(tile);
  } else if (tile.type === 'folder') {
    tileStore.openFolder(tile);
  }
}

function handleTileContextMenu(event: MouseEvent, tile: TileData) {
  tileStore.openContextMenu(event.clientX, event.clientY, tile, props.group.id);
}

function handleGroupContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  tileStore.openContextMenu(event.clientX, event.clientY, null, props.group.id);
}

function handleAddFile() {
  const name = prompt(`在「${props.group.title}」中新建文件磁贴：`, '新文档.md');
  if (name && name.trim()) {
    tileStore.addNewFile({ title: name.trim() }, props.group.id);
  }
}

// Group header pointer down for whole-group reordering
let headerPointerDownPos: { x: number; y: number } | null = null;

function onHeaderPointerDown(event: PointerEvent) {
  if (isEditingTitle.value || isResizingWidth.value || event.button !== 0) return;
  const target = event.target as HTMLElement;
  if (target.closest('button') || target.closest('input') || target.closest('.group-width-resizer')) return;

  headerPointerDownPos = { x: event.clientX, y: event.clientY };

  const onMove = (moveEvent: PointerEvent) => {
    if (!headerPointerDownPos) return;
    const dx = Math.abs(moveEvent.clientX - headerPointerDownPos.x);
    const dy = Math.abs(moveEvent.clientY - headerPointerDownPos.y);
    if (dx > 4 || dy > 4) {
      cleanup();
      emit('group-drag-start', moveEvent, props.group);
    }
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', cleanup);
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', cleanup);
}

// Width resize drag handler (stepping by minimum units 56px)
function onWidthResizePointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.stopPropagation();
  event.preventDefault();

  const startX = event.clientX;
  const initialCols = groupColumns.value;
  isResizingWidth.value = true;
  liveWidthCols.value = initialCols;

  const onPointerMove = (e: PointerEvent) => {
    const dx = e.clientX - startX;
    const delta = Math.round(dx / (UNIT_SIZE + GRID_GAP));

    // Calculate maximum tile boundary to prevent shrinking below occupied tiles
    let maxTileRight = 1;
    for (const t of props.tiles) {
      const span = getTileSpan(t.size, t.customSpan);
      if (t.x + span.w > maxTileRight) maxTileRight = t.x + span.w;
    }

    const minCols = Math.max(2, maxTileRight);
    const newCols = Math.max(minCols, Math.min(12, initialCols + delta));
    liveWidthCols.value = newCols;
  };

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    if (liveWidthCols.value && liveWidthCols.value !== initialCols) {
      tileStore.setGroupWidth(props.group.id, liveWidthCols.value);
    }
    isResizingWidth.value = false;
    liveWidthCols.value = null;
  };

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
}

defineExpose({
  getGridElement: () => groupGridRef.value,
});
</script>

<template>
  <div
    class="archive-tile-group relative flex flex-col select-none mb-8 transition-opacity duration-150"
    :class="[
      tileStore.groupDragState.isDragging && tileStore.groupDragState.groupId === group.id
        ? 'opacity-25 pointer-events-none'
        : '',
    ]"
    :data-group-container-id="group.id"
  >
    <!-- Drop indicator before this group -->
    <div
      v-if="
        tileStore.groupDragState.isDragging &&
        tileStore.groupDragState.targetGroupId === group.id &&
        tileStore.groupDragState.dropPosition === 'before'
      "
      class="h-1.5 w-full bg-sky-400 rounded-full mb-2 shadow-[0_0_10px_rgba(56,189,248,0.9)] transition-all animate-pulse"
    />

    <!-- Group Title Header (Acts as Whole-Group Drag Handle & Width Resize Handle) -->
    <div
      class="group/hdr relative flex items-center justify-between px-1.5 py-1 mb-2.5 cursor-grab active:cursor-grabbing hover:bg-white/5 rounded transition-colors"
      :style="{ width: `${canvasWidth}px` }"
      @pointerdown="onHeaderPointerDown"
      @contextmenu="handleGroupContextMenu"
    >
      <!-- Title & Rename -->
      <div v-if="!isEditingTitle" class="flex items-center gap-1.5 min-w-0">
        <GripVertical class="size-3.5 text-white/30 opacity-0 group-hover/hdr:opacity-100 transition-opacity shrink-0" />
        <h3
          class="text-sm font-medium tracking-wide text-white/80 hover:text-white truncate transition-colors cursor-pointer"
          title="点击重命名分组，拖动整组重排"
          @click.stop="isEditingTitle = true"
        >
          {{ group.title }}
        </h3>
        <Pencil
          class="size-3 text-white/30 opacity-0 group-hover/hdr:opacity-100 transition-opacity shrink-0 cursor-pointer"
          @click.stop="isEditingTitle = true"
        />
      </div>

      <div v-else class="flex items-center" @click.stop>
        <input
          v-model="titleVal"
          type="text"
          class="h-7 rounded border border-white/30 bg-black/50 px-2 text-xs text-white outline-none focus:border-sky-400"
          @keydown.enter="saveTitle"
          @blur="saveTitle"
          autofocus
        />
      </div>

      <!-- Right actions: Add Tile Button & Live Width Badge -->
      <div class="flex items-center gap-1 pr-3">
        <!-- Live Column Width indicator while dragging width -->
        <span
          v-if="isResizingWidth"
          class="text-[10px] font-mono text-sky-300 font-semibold bg-sky-950/80 px-1.5 py-0.5 rounded border border-sky-400/50"
        >
          {{ currentCols }} 列
        </span>

        <button
          type="button"
          class="opacity-0 group-hover/hdr:opacity-100 p-1 text-white/50 hover:text-white rounded hover:bg-white/10 transition-all"
          title="向此分组添加新磁贴"
          @click.stop="handleAddFile"
        >
          <Plus class="size-3.5" />
        </button>
      </div>

      <!-- Group Width Resize Handle on Right Edge (stepping by minimum units) -->
      <div
        class="group-width-resizer absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize flex items-center justify-center hover:bg-sky-400/20 rounded-r transition-colors z-20 select-none"
        title="拖动调整栏宽度 (最小格单位)"
        @pointerdown="onWidthResizePointerDown"
      >
        <div class="w-0.5 h-3.5 bg-white/20 group-hover/hdr:bg-white/40 hover:!bg-sky-400 rounded-full transition-colors" />
      </div>
    </div>

    <!-- Group Tiles Matrix Canvas -->
    <div
      ref="groupGridRef"
      class="relative transition-[height,width] duration-200 ease-out"
      :style="{ width: `${canvasWidth}px`, height: `${canvasHeight}px` }"
      :data-group-id="group.id"
      @contextmenu.self="handleGroupContextMenu"
    >
      <!-- Faint Underlying Base Unit Grid (若隐若现底层网格) -->
      <div
        class="pointer-events-none absolute inset-0 z-0 transition-opacity duration-300"
        :class="tileStore.dragState.isDragging ? 'opacity-100' : 'opacity-0'"
      >
        <div
          class="grid"
          :style="{
            gridTemplateColumns: `repeat(${currentCols}, ${UNIT_SIZE}px)`,
            gridAutoRows: `${UNIT_SIZE}px`,
            gap: `${GRID_GAP}px`,
            width: `${canvasWidth}px`,
          }"
        >
          <div
            v-for="i in currentCols * totalRows"
            :key="i"
            class="rounded-[2px] border border-white/[0.08] bg-white/[0.02] shadow-[inset_0_0_8px_rgba(255,255,255,0.01)]"
          />
        </div>
      </div>

      <!-- Ghost placeholder slot when dragging tile -->
      <div
        v-if="ghostStyle"
        class="pointer-events-none absolute top-0 left-0 z-10 rounded-[2px] border-2 border-dashed border-sky-400 bg-sky-400/25 backdrop-blur-xs shadow-[0_0_14px_rgba(56,189,248,0.35)] transition-all duration-100"
        :class="tileStore.dragState.hoverPhase === 'candidate' ? 'opacity-45' : ''"
        :style="ghostStyle"
      />

      <!-- Tiles inside this group -->
      <template v-for="tile in tiles" :key="tile.id">
        <FolderTile
          v-if="tile.type === 'folder'"
          :folder="tile"
          :is-dragging="tileStore.dragState.isDragging && tileStore.dragState.tile?.id === tile.id"
          :is-drop-target="tileStore.dragState.hoverTargetTileId === tile.id"
          @click="handleTileClick(tile)"
          @contextmenu="handleTileContextMenu($event, tile)"
          @dragstart="(event, _t, grabOffset) => emit('dragstart', event, tile, grabOffset)"
        />
        <FileTile
          v-else
          :file="tile"
          :is-dragging="tileStore.dragState.isDragging && tileStore.dragState.tile?.id === tile.id"
          :is-drop-target="tileStore.dragState.hoverTargetTileId === tile.id"
          @click="handleTileClick(tile)"
          @contextmenu="handleTileContextMenu($event, tile)"
          @dragstart="(event, _t, grabOffset) => emit('dragstart', event, tile, grabOffset)"
        />
      </template>
    </div>

    <!-- Drop indicator after this group -->
    <div
      v-if="
        tileStore.groupDragState.isDragging &&
        tileStore.groupDragState.targetGroupId === group.id &&
        tileStore.groupDragState.dropPosition === 'after'
      "
      class="h-1.5 w-full bg-sky-400 rounded-full mt-2 shadow-[0_0_10px_rgba(56,189,248,0.9)] transition-all animate-pulse"
    />
  </div>
</template>
