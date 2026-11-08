<script setup lang="ts">
import { computed, onUnmounted } from 'vue';
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  RefreshCw,
  Sparkles,
  UnfoldHorizontal,
  X,
} from '@lucide/vue';
import type { FileTileData, FolderDragState, FolderTileData, TileData } from '../../types/tile';
import {
  countFolderItemsRecursive,
  getTilePixelDimensions,
  GRID_GAP,
  UNIT_SIZE,
  useTileStore,
} from '@/stores/archive/stores/tileStore';
import { archiveDomRegistry } from '../../store/archiveDomRegistry';
import { isTelegramMediaTile } from '../../utils/tilePresentation';
import FileTile from '../tiles/FileTile.vue';
import FolderTile from '../tiles/FolderTile.vue';

const props = defineProps<{
  folder: FolderTileData;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const tileStore = useTileStore();

const folderMarqueeRectStyle = computed(() => {
  const m = tileStore.folderMarqueeState;
  if (!m.isSelecting) return null;
  const projectedStartX = m.startX - ((m.currentScrollLeft ?? 0) - (m.startScrollLeft ?? 0));
  const projectedStartY = m.startY - ((m.currentScrollTop ?? 0) - (m.startScrollTop ?? 0));
  const left = Math.min(projectedStartX, m.currentX);
  const top = Math.min(projectedStartY, m.currentY);
  const width = Math.abs(m.currentX - projectedStartX);
  const height = Math.abs(m.currentY - projectedStartY);
  if (width < 3 && height < 3) return null;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
});

let folderAutoScrollRaf: number | null = null;
let folderAutoScrollVy = 0;
let onFolderAutoScrollTick: (() => void) | null = null;

function stopFolderAutoScroll() {
  if (folderAutoScrollRaf !== null) {
    cancelAnimationFrame(folderAutoScrollRaf);
    folderAutoScrollRaf = null;
  }
  folderAutoScrollVy = 0;
  onFolderAutoScrollTick = null;
}

function updateFolderAutoScroll(containerEl: HTMLElement, clientY: number, onTick?: () => void) {
  if (onTick) {
    onFolderAutoScrollTick = onTick;
  }
  const rect = containerEl.getBoundingClientRect();
  const threshold = 50;
  const maxSpeed = 18;

  let vy = 0;
  if (clientY > rect.bottom - threshold && clientY <= rect.bottom + 40) {
    const ratio = Math.min(1, Math.max(0.15, (clientY - (rect.bottom - threshold)) / threshold));
    vy = Math.round(ratio * maxSpeed);
  } else if (clientY < rect.top + threshold && clientY >= rect.top - 40) {
    const ratio = Math.min(1, Math.max(0.15, ((rect.top + threshold) - clientY) / threshold));
    vy = -Math.round(ratio * maxSpeed);
  }

  folderAutoScrollVy = vy;

  if (vy !== 0) {
    if (folderAutoScrollRaf === null) {
      const step = () => {
        if (!containerEl || folderAutoScrollVy === 0) {
          stopFolderAutoScroll();
          return;
        }
        const prevTop = containerEl.scrollTop;
        containerEl.scrollTop += folderAutoScrollVy;
        if (containerEl.scrollTop !== prevTop) {
          onFolderAutoScrollTick?.();
        }
        folderAutoScrollRaf = requestAnimationFrame(step);
      };
      folderAutoScrollRaf = requestAnimationFrame(step);
    }
  } else {
    stopFolderAutoScroll();
  }
}

const groupTitle = computed(
  () => tileStore.groups.find((g) => g.id === props.folder.groupId)?.title ?? '未分组',
);

const totalRecursiveCount = computed(() => countFolderItemsRecursive(props.folder));

/** 文件夹弹窗内部拖拽会话（状态在 store，视图只读取） */
const folderDragState = computed(() => tileStore.folderDragState);

/** 跟随光标的拖拽残影样式（居中对齐指针） */
const folderDragGhostStyle = computed(() => {
  const state = folderDragState.value;
  if (!state.isDragging) return null;
  return {
    left: `${state.pointerX - state.width / 2}px`,
    top: `${state.pointerY - state.height / 2}px`,
    width: `${state.width}px`,
    height: `${state.height}px`,
  };
});

function bindFolderModalRef(el: unknown) {
  archiveDomRegistry.setFolderModalEl(el);
}

function bindFolderGridRef(el: unknown) {
  archiveDomRegistry.setFolderGridEl(el);
}

function startEditingTitle() {
  tileStore.folderModalTitleDraft = props.folder.title;
  tileStore.isEditingFolderModalTitle = true;
}

function saveTitle() {
  if (tileStore.folderModalTitleDraft.trim()) {
    tileStore.renameTile(props.folder.id, tileStore.folderModalTitleDraft.trim());
  }
  tileStore.isEditingFolderModalTitle = false;
}

function handleDissolve() {
  if (confirm(`确定要解散文件夹「${props.folder.title}」吗？其中的项目将移至上一级。`)) {
    tileStore.dissolveFolder(props.folder.id);
  }
}

function handleItemContextMenu(event: MouseEvent, item: TileData) {
  event.preventDefault();
  event.stopPropagation();
  if (
    tileStore.folderSelectedTileIds.length > 0 &&
    !tileStore.folderSelectedTileIds.includes(item.id)
  ) {
    tileStore.setFolderSelectedTileIds([item.id]);
  }
  tileStore.openContextMenu(
    event.clientX,
    event.clientY,
    item,
    props.folder.groupId,
    false,
    props.folder.id,
  );
}

function handleFolderBlankContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null;
  if (target?.closest('[data-folder-tile-id]')) return;
  event.preventDefault();
  event.stopPropagation();
  tileStore.openContextMenu(
    event.clientX,
    event.clientY,
    null,
    props.folder.groupId,
    false,
    props.folder.id,
  );
}

function handleAddSubFolderQuick() {
  const name = prompt('请输入新建子文件夹名称：', '新建子文件夹');
  if (name && name.trim()) {
    tileStore.addSubFolder(props.folder.id, name.trim());
  }
}

function handleAddFileQuick() {
  const name = prompt('请输入新添加的文件名称：', '新建备忘文档.md');
  if (name && name.trim()) {
    const ext = name.includes('.') ? name.split('.').pop() : 'txt';
    tileStore.addNewFile(
      {
        title: name.trim(),
        fileType: ext === 'pdf' ? 'pdf' : ext === 'md' || ext === 'doc' ? 'doc' : 'text',
        extension: ext,
      },
      props.folder.groupId,
      props.folder.id,
    );
  }
}

function handleOpenChild(item: TileData) {
  if (item.type === 'folder') {
    tileStore.openFolder(item);
    return;
  }
  const file = item as FileTileData;
  if (isTelegramMediaTile(file, tileStore.resources)) void tileStore.openTelegramMedia(file);
  else tileStore.openFile(file);
}

/**
 * 计算插入目标：DOM 顺序与 folder.children 数组顺序一致（v-for 按数组渲染），
 * 因此只需跳过被拖拽项，找到指针最近的兄弟磁贴，再判断插到它前面还是后面。
 */
function computeInsertTarget(
  gridEl: HTMLElement | null,
  ids: string[],
  px: number,
  py: number,
): { index: number; bar: FolderDragState['insertRect'] } {
  const els = Array.from(
    gridEl?.querySelectorAll<HTMLElement>('[data-folder-tile-id]') ?? [],
  ).filter((el) => !ids.includes(el.dataset.folderTileId ?? ''));

  let bestEl: HTMLElement | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  let bestAfter = true;

  for (const el of els) {
    const r = el.getBoundingClientRect();
    const dx = Math.max(r.left - px, 0, px - r.right);
    const dy = Math.max(r.top - py, 0, py - r.bottom);
    const dist = Math.hypot(dx, dy);
    if (dist >= bestDist) continue;
    bestDist = dist;
    bestEl = el;
    const cy = r.top + r.height / 2;
    const cx = r.left + r.width / 2;
    // 指针偏在该元素中心之后（先比 Y，Y 接近时再比 X）→ 插到它后面
    bestAfter = py > cy || (Math.abs(py - cy) <= r.height / 2 && px > cx);
  }

  if (!bestEl) return { index: 0, bar: null };

  const target: HTMLElement = bestEl;
  const index = els.indexOf(target) + (bestAfter ? 1 : 0);
  const r = target.getBoundingClientRect();
  return {
    index,
    bar: { left: bestAfter ? r.right + 3 : r.left - 3, top: r.top, height: r.height },
  };
}

/**
 * 文件夹内拖拽分流：
 * - 指针仍在弹窗卡片内 → 内部重排（改变 folder.children 顺序）
 * - 指针离开弹窗卡片 → 立即移交磁贴板（必须在 pointermove 中移交，
 *   TileBoard 的 sync watcher 会 closeFolder() 并 beginTileDrag() 接管后续移动）
 */
function onChildDragStart(
  event: PointerEvent,
  item: TileData,
  _grabOffset?: { x: number; y: number },
) {
  const multiSelected =
    tileStore.folderSelectedTileIds.length > 1 &&
    tileStore.folderSelectedTileIdSet.has(item.id);
  const ids = multiSelected ? [...tileStore.folderSelectedTileIds] : [item.id];

  const { width, height } = getTilePixelDimensions(item.size, item.customSpan);
  tileStore.beginFolderDrag(props.folder.id, ids, width, height);
  tileStore.updateFolderDrag(event.clientX, event.clientY, 0, null, false);

  let handedOff = false;
  /** 指针离开弹窗卡片的起始时刻（0 表示当前在卡片内） */
  let outsideSince = 0;
  /** 离开弹窗需持续的时间，避免边缘误触直接弹飞 */
  const OUTSIDE_DWELL_MS = 150;

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
  };

  const onMove = (moveEvent: PointerEvent) => {
    if (handedOff) return;

    // 1) 指针是否已离开弹窗卡片（离开需持续 OUTSIDE_DWELL_MS 才真正移交）
    const modalEl = archiveDomRegistry.getFolderModalEl();
    const rect = modalEl?.getBoundingClientRect();
    const isOutsideNow =
      !!rect &&
      (moveEvent.clientX < rect.left ||
        moveEvent.clientX > rect.right ||
        moveEvent.clientY < rect.top ||
        moveEvent.clientY > rect.bottom);

    const now = performance.now();
    if (!isOutsideNow) {
      outsideSince = 0;
    } else if (outsideSince === 0) {
      outsideSince = now;
    }
    const handedOffNow = outsideSince > 0 && now - outsideSince >= OUTSIDE_DWELL_MS;

    // 2) 计算插入下标与指示线
    const target = computeInsertTarget(
      archiveDomRegistry.getFolderGridEl(),
      ids,
      moveEvent.clientX,
      moveEvent.clientY,
    );
    tileStore.updateFolderDrag(
      moveEvent.clientX,
      moveEvent.clientY,
      target.index,
      target.bar,
      isOutsideNow,
    );

    // 3) 已在卡片外停留足够久 → 立即移交磁贴板
    if (handedOffNow) {
      handedOff = true;
      cleanup();
      tileStore.endFolderDrag();
      if (ids.length > 1) tileStore.setSelectedTileIds([...ids]);
      tileStore.beginFolderChildDrag(item, props.folder, moveEvent.clientX, moveEvent.clientY);
    }
  };

  const onUp = () => {
    cleanup();
    if (handedOff) return;
    const state = tileStore.folderDragState;
    if (state.isDragging && !state.isOutside) {
      tileStore.reorderFolderChildren(props.folder.id, [...state.ids], state.insertIndex);
    }
    tileStore.endFolderDrag();
  };

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

/**
 * 在文件夹网格空白处按住左键拖拽 → 启动框选 (Marquee Selection)
 * 深度兼容垂直滚动与边缘平滑自动滚动
 */
function onFolderSectionPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement | null;
  if (!target) return;
  if (
    target.closest('[data-folder-tile-id]') ||
    target.closest('button') ||
    target.closest('input')
  ) {
    return;
  }

  const containerEl = (event.currentTarget as HTMLElement) || target.closest('section');
  const startX = event.clientX;
  const startY = event.clientY;
  const startScrollLeft = containerEl ? containerEl.scrollLeft : 0;
  const startScrollTop = containerEl ? containerEl.scrollTop : 0;
  const additive = event.ctrlKey || event.metaKey || event.shiftKey;
  const baseSelectedIds = additive ? [...tileStore.folderSelectedTileIds] : [];
  let hasMovedMarquee = false;

  const updateHits = (currX: number, currY: number) => {
    const curScrollLeft = containerEl ? containerEl.scrollLeft : startScrollLeft;
    const curScrollTop = containerEl ? containerEl.scrollTop : startScrollTop;

    tileStore.folderMarqueeState.currentScrollLeft = curScrollLeft;
    tileStore.folderMarqueeState.currentScrollTop = curScrollTop;

    const projectedStartX = startX - (curScrollLeft - startScrollLeft);
    const projectedStartY = startY - (curScrollTop - startScrollTop);

    const boxLeft = Math.min(projectedStartX, currX);
    const boxRight = Math.max(projectedStartX, currX);
    const boxTop = Math.min(projectedStartY, currY);
    const boxBottom = Math.max(projectedStartY, currY);

    const tileEls = Array.from(document.querySelectorAll('[data-folder-tile-id]')) as HTMLElement[];
    const hitIds = new Set<string>(baseSelectedIds);
    for (const el of tileEls) {
      const tid = el.getAttribute('data-folder-tile-id');
      if (!tid) continue;
      const r = el.getBoundingClientRect();
      const intersects =
        r.left < boxRight &&
        r.right > boxLeft &&
        r.top < boxBottom &&
        r.bottom > boxTop;
      if (intersects) {
        hitIds.add(tid);
      }
    }
    tileStore.setFolderSelectedTileIds(Array.from(hitIds));
  };

  const onContainerScroll = () => {
    if (hasMovedMarquee && tileStore.folderMarqueeState.isSelecting) {
      updateHits(tileStore.folderMarqueeState.currentX, tileStore.folderMarqueeState.currentY);
    }
  };

  const onMove = (moveEvent: PointerEvent) => {
    const curScrollLeft = containerEl ? containerEl.scrollLeft : startScrollLeft;
    const curScrollTop = containerEl ? containerEl.scrollTop : startScrollTop;
    const projectedStartX = startX - (curScrollLeft - startScrollLeft);
    const projectedStartY = startY - (curScrollTop - startScrollTop);

    const dx = Math.abs(moveEvent.clientX - projectedStartX);
    const dy = Math.abs(moveEvent.clientY - projectedStartY);
    if (!hasMovedMarquee && dx < 4 && dy < 4) return;

    if (!hasMovedMarquee) {
      hasMovedMarquee = true;
      tileStore.folderMarqueeState = {
        isSelecting: true,
        startX,
        startY,
        currentX: moveEvent.clientX,
        currentY: moveEvent.clientY,
        startScrollLeft,
        startScrollTop,
        currentScrollLeft: curScrollLeft,
        currentScrollTop: curScrollTop,
        additive,
        baseSelectedIds,
      };
    } else {
      tileStore.folderMarqueeState.currentX = moveEvent.clientX;
      tileStore.folderMarqueeState.currentY = moveEvent.clientY;
    }

    if (containerEl) {
      updateFolderAutoScroll(containerEl, moveEvent.clientY, () => {
        updateHits(tileStore.folderMarqueeState.currentX, tileStore.folderMarqueeState.currentY);
      });
    }
    updateHits(moveEvent.clientX, moveEvent.clientY);
  };

  const onUp = () => {
    stopFolderAutoScroll();
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    containerEl?.removeEventListener('scroll', onContainerScroll);

    if (!hasMovedMarquee && !additive && tileStore.folderSelectedTileIds.length > 0) {
      tileStore.clearFolderSelectedTiles();
    }
    tileStore.folderMarqueeState.isSelecting = false;
  };

  containerEl?.addEventListener('scroll', onContainerScroll, { passive: true });
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

onUnmounted(() => {
  stopFolderAutoScroll();
  tileStore.folderMarqueeState.isSelecting = false;
  tileStore.endFolderDrag();
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-[1px]"
    @click.self="emit('close')"
  >
    <!-- 文件夹详情：支持无限嵌套面包屑下钻与返回 -->
    <div
      :ref="bindFolderModalRef"
      class="archive-modal-card relative flex h-[min(860px,90vh)] w-[min(1280px,94vw)] flex-col overflow-hidden border border-white/15 bg-[#0f172a]/70 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.14),0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-2xl"
    >
      <!-- 顶栏 + 面包屑路径条 -->
      <header class="flex shrink-0 flex-wrap items-center gap-2 border-b border-white/10 px-4 py-3">
        <span
          class="flex size-[26px] shrink-0 items-center justify-center border border-amber-400/25 bg-amber-500/15 text-amber-300"
        >
          <Folder class="size-4" :stroke-width="1.75" />
        </span>

        <!-- 面包屑导航栈 -->
        <nav class="flex min-w-0 items-center gap-1 overflow-x-auto text-[12px]">
          <span class="shrink-0 text-white/45">{{ groupTitle }}</span>
          <template v-for="(crumb, idx) in tileStore.folderPathStack" :key="crumb.id">
            <ChevronRight class="size-3.5 shrink-0 text-white/30" />
            <button
              v-if="idx < tileStore.folderPathStack.length - 1"
              type="button"
              class="shrink-0 rounded px-1.5 py-0.5 text-sky-300/90 transition-colors hover:bg-white/10 hover:text-white"
              @click="tileStore.navigateToBreadcrumbFolder(crumb.id)"
            >
              {{ crumb.title }}
            </button>
          </template>
        </nav>

        <div v-if="!tileStore.isEditingFolderModalTitle" class="flex min-w-0 items-baseline gap-2">
          <h2
            class="cursor-text truncate text-[14px] font-medium tracking-wide text-white/95 transition-colors hover:text-white"
            title="点击重命名当前文件夹"
            @click="startEditingTitle"
          >
            {{ folder.title }}
          </h2>
          <span class="shrink-0 font-mono text-[10px] text-white/40">
            {{ folder.children.length }} 直属 · 共 {{ totalRecursiveCount }} 项
          </span>
        </div>

        <div v-else class="flex min-w-0 items-center">
          <input
            :value="tileStore.folderModalTitleDraft"
            type="text"
            class="h-7 w-56 max-w-full border border-white/25 bg-black/40 px-2 text-xs text-white outline-none focus:border-sky-400/70"
            autofocus
            @input="tileStore.folderModalTitleDraft = ($event.target as HTMLInputElement).value"
            @keydown.enter="saveTitle"
            @blur="saveTitle"
          />
        </div>

        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <!-- 封面重载状态横幅 -->
          <div
            v-if="tileStore.coverRefreshBannerText"
            class="flex items-center gap-1.5 rounded-[2px] border border-emerald-400/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200"
          >
            <RefreshCw
              class="size-3 shrink-0 text-emerald-400"
              :class="tileStore.isRefreshingTileCovers ? 'animate-spin' : ''"
            />
            <span class="max-w-[260px] truncate">{{ tileStore.coverRefreshBannerText }}</span>
          </div>

          <button
            type="button"
            class="flex h-[26px] items-center gap-1 border border-sky-400/30 bg-sky-500/15 px-2 text-[11px] text-sky-200 transition-colors hover:bg-sky-500/25"
            title="按 Telegram 原生 ID（document.id / photo.id / peerKey）清理此文件夹内的重复磁贴并合并多源定位"
            @click="tileStore.deduplicateTiles({ scope: 'folder', folderId: folder.id })"
          >
            <Sparkles class="size-3.5" />
            <span>去重整理</span>
          </button>

          <button
            type="button"
            class="flex h-[26px] items-center gap-1 border border-emerald-400/30 bg-emerald-500/15 px-2 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/25"
            title="重新载入当前文件夹内加载失败或缺失的贴图"
            @click="tileStore.reloadMissingOrFailedTileCovers(folder.id)"
          >
            <RefreshCw class="size-3.5" :class="tileStore.isRefreshingTileCovers ? 'animate-spin' : ''" />
            <span>重载缺失贴图</span>
          </button>

          <button
            type="button"
            class="flex h-[26px] items-center gap-1 border border-amber-400/30 bg-amber-500/15 px-2 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/25"
            title="在当前文件夹内新建子文件夹"
            @click="handleAddSubFolderQuick"
          >
            <FolderPlus class="size-3.5" />
            <span>新建子文件夹</span>
          </button>
          <button
            type="button"
            class="flex size-[26px] items-center justify-center border border-white/10 text-white/45 transition-colors hover:border-white/25 hover:text-white"
            title="关闭"
            @click="emit('close')"
          >
            <X class="size-3.5" :stroke-width="1.75" />
          </button>
        </div>
      </header>

      <!-- 主体 -->
      <div class="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[1fr_300px]">
        <!-- 左：迷你磁贴网格（同时渲染子文件夹与子文件，支持空白区域右键菜单与拖拽框选） -->
        <section
          class="folder-modal-scroll relative min-h-0 overflow-y-auto select-none p-4 md:p-6"
          @pointerdown="onFolderSectionPointerDown"
          @contextmenu="handleFolderBlankContextMenu"
        >
          <!-- Archive 同款像素网格：UNIT_SIZE=50 / GRID_GAP=6，跨度由 BaseTile 内联 gridColumn/gridRow 提供 -->
          <div
            :ref="bindFolderGridRef"
            class="relative grid"
            :style="{
              gridTemplateColumns: `repeat(auto-fill, ${UNIT_SIZE}px)`,
              gridAutoRows: `${UNIT_SIZE}px`,
              gap: `${GRID_GAP}px`,
              gridAutoFlow: 'dense',
            }"
          >
            <template v-for="child in folder.children" :key="child.id">
              <FolderTile
                v-if="child.type === 'folder'"
                :folder="child"
                in-folder-grid
                :title="child.title"
                @click="handleOpenChild($event)"
                @contextmenu="handleItemContextMenu($event, child)"
                @dragstart="(e, t, off) => onChildDragStart(e, t, off)"
              />
              <FileTile
                v-else
                :file="child"
                in-folder-grid
                @click="handleOpenChild($event)"
                @contextmenu="handleItemContextMenu($event, child)"
                @dragstart="(e, t, off) => onChildDragStart(e, t, off)"
              />
            </template>

            <!-- 添加子文件夹 -->
            <button
              type="button"
              class="flex flex-col items-center justify-center gap-1 border border-dashed border-amber-400/20 text-amber-300/50 transition-colors hover:border-amber-400/45 hover:bg-amber-500/[0.06] hover:text-amber-200"
              :style="{ gridColumn: 'span 2', gridRow: 'span 2', width: '106px', height: '106px' }"
              title="新建子文件夹"
              @click="handleAddSubFolderQuick"
            >
              <FolderPlus class="size-4" :stroke-width="1.75" />
              <span class="text-[9px]">子文件夹</span>
            </button>

            <!-- 添加文件 -->
            <button
              type="button"
              class="flex flex-col items-center justify-center gap-1 border border-dashed border-white/15 text-white/35 transition-colors hover:border-white/30 hover:bg-white/[0.04] hover:text-white/75"
              :style="{ gridColumn: 'span 2', gridRow: 'span 2', width: '106px', height: '106px' }"
              title="添加文件"
              @click="handleAddFileQuick"
            >
              <Plus class="size-4" :stroke-width="1.75" />
              <span class="text-[9px]">添加文件</span>
            </button>
          </div>

          <p
            v-if="folder.children.length === 0"
            class="mt-4 text-center text-[11px] text-white/35"
          >
            拖入磁贴，或在空白处右键新建子文件夹 / 文件 / 重载贴图
          </p>
        </section>

        <!-- 右：文件夹属性与操作 -->
        <aside class="flex min-h-0 flex-col border-t border-white/10 md:border-l md:border-t-0">
          <div class="folder-modal-scroll min-h-0 flex-1 overflow-y-auto px-5 py-6">
            <p class="text-[10px] uppercase tracking-[0.18em] text-white/30">文件夹层级属性</p>

            <dl class="mt-2 divide-y divide-white/[0.06] text-[11px]">
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">直属子项</dt>
                <dd class="font-mono text-white/75">{{ folder.children.length }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">递归总计</dt>
                <dd class="font-mono text-white/75">{{ totalRecursiveCount }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">嵌套深度</dt>
                <dd class="font-mono text-sky-300">L{{ tileStore.folderPathStack.length }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">所在分组</dt>
                <dd class="truncate text-white/75">{{ groupTitle }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">创建日期</dt>
                <dd class="font-mono text-white/75">{{ folder.createdAt }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3 py-2">
                <dt class="text-white/40">更新时间</dt>
                <dd class="font-mono text-white/75">{{ folder.updatedAt }}</dd>
              </div>
            </dl>
          </div>

          <div class="shrink-0 space-y-2 border-t border-white/10 p-3">
            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-sky-400/30 bg-sky-500/15 py-2 text-[11px] text-sky-200 transition-colors hover:bg-sky-500/25"
              @click="tileStore.deduplicateTiles({ scope: 'folder', folderId: folder.id })"
            >
              <Sparkles class="size-3.5" :stroke-width="1.75" />
              <span>清理重复磁贴 (按 TG ID)</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-emerald-400/30 bg-emerald-500/15 py-2 text-[11px] text-emerald-200 transition-colors hover:bg-emerald-500/25"
              @click="tileStore.reloadMissingOrFailedTileCovers(folder.id)"
            >
              <RefreshCw class="size-3.5" :class="tileStore.isRefreshingTileCovers ? 'animate-spin' : ''" :stroke-width="1.75" />
              <span>重新载入缺失/失败的贴图</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-amber-400/30 bg-amber-500/15 py-2 text-[11px] text-amber-200 transition-colors hover:bg-amber-500/25"
              @click="handleAddSubFolderQuick"
            >
              <FolderPlus class="size-3.5" :stroke-width="1.75" />
              <span>新建子文件夹</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 bg-white/10 py-2 text-[11px] text-white/85 transition-colors hover:bg-white/15"
              @click="handleAddFileQuick"
            >
              <Plus class="size-3.5" :stroke-width="1.75" />
              <span>添加文件</span>
            </button>

            <button
              type="button"
              class="flex w-full items-center justify-center gap-1.5 border border-white/10 py-2 text-[11px] text-white/55 transition-colors hover:border-white/25 hover:text-white"
              @click="handleDissolve"
            >
              <UnfoldHorizontal class="size-3.5" :stroke-width="1.75" />
              <span>解散文件夹</span>
            </button>
          </div>
        </aside>
      </div>

      <!-- 文件夹内部拖拽框选半透明矩形框（通过 Teleport 挂载到 body，彻底消除包含块 backdrop-blur-2xl 引发的 fixed 视口坐标偏移） -->
      <Teleport to="body">
        <div
          v-if="folderMarqueeRectStyle"
          class="pointer-events-none fixed z-[9999] rounded-[2px] border border-sky-400/90 bg-sky-500/20 shadow-[0_0_16px_rgba(56,189,248,0.28)]"
          :style="folderMarqueeRectStyle"
        />

        <!-- 文件夹内部重排：拖拽残影（跟随光标）；离开弹窗时提示即将移出 -->
        <div
          v-if="folderDragState.isDragging"
          class="pointer-events-none fixed z-[9999] flex items-center justify-center rounded-[2px] border text-[12px] font-bold shadow-2xl"
          :class="
            folderDragState.isOutside
              ? 'border-amber-400/80 bg-amber-950/90 text-amber-200'
              : 'border-sky-400/70 bg-[#0f172a]/90 text-sky-200'
          "
          :style="folderDragGhostStyle"
        >
          <span
            v-if="folderDragState.ids.length > 1"
            class="flex size-6 items-center justify-center rounded-[2px] bg-sky-500 font-mono text-[11px] text-white"
          >
            {{ folderDragState.ids.length }}
          </span>
          <span v-else-if="folderDragState.isOutside" class="px-1.5 text-[9px] font-medium leading-tight">
            移出到磁贴板
          </span>
        </div>

        <!-- 文件夹内部重排：插入位置指示线 -->
        <div
          v-if="folderDragState.isDragging && folderDragState.insertRect && !folderDragState.isOutside"
          class="pointer-events-none fixed z-[9998] w-0.5 rounded-full bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.9)]"
          :style="{
            left: `${folderDragState.insertRect.left}px`,
            top: `${folderDragState.insertRect.top}px`,
            height: `${folderDragState.insertRect.height}px`,
          }"
        />
      </Teleport>
    </div>
  </div>
</template>

<style scoped>
.folder-modal-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.18) transparent;
}

.folder-modal-scroll::-webkit-scrollbar {
  width: 6px;
}

.folder-modal-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.folder-modal-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
}
</style>
