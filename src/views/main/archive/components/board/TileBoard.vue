<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { GripVertical, Plus } from '@lucide/vue';
import type { TileData, TileGroupData } from '../../types/tile';
import {
  getTilePixelDimensions,
  getTileSpan,
  GRID_GAP,
  GROUP_COLUMNS,
  UNIT_SIZE,
  useTileStore,
} from '../../store/tileStore';
import { computeDisplacedPositions } from '../../utils/layoutEngine';
import TileGroupContainer from './TileGroupContainer.vue';
import FileTile from '../tiles/FileTile.vue';
import FolderTile from '../tiles/FolderTile.vue';

const tileStore = useTileStore();
const boardRef = ref<HTMLElement | null>(null);

function checkAutoScroll(clientX: number, clientY: number) {
  if (!boardRef.value) return;
  const rect = boardRef.value.getBoundingClientRect();
  const threshold = 60;
  // Vertical auto-scroll
  if (clientY > rect.bottom - threshold && clientY <= rect.bottom + 40) {
    boardRef.value.scrollTop += 14;
  } else if (clientY < rect.top + threshold && clientY >= rect.top - 40) {
    boardRef.value.scrollTop -= 14;
  }
  // Horizontal auto-scroll
  if (clientX > rect.right - threshold && clientX <= rect.right + 40) {
    boardRef.value.scrollLeft += 14;
  } else if (clientX < rect.left + threshold && clientX >= rect.left - 40) {
    boardRef.value.scrollLeft -= 14;
  }
}

const groupsByColumn = computed(() => {
  return tileStore.columns;
});

// Floating drag preview attached precisely to cursor at grab point (1:1 with cursor)
const dragPreviewStyle = computed(() => {
  if (!tileStore.dragState.isDragging || !tileStore.dragState.tile) return null;
  const { width, height } = getTilePixelDimensions(
    tileStore.dragState.tile.size,
    tileStore.dragState.tile.customSpan,
  );
  const left = tileStore.dragState.pointerX - tileStore.dragState.offsetX;
  const top = tileStore.dragState.pointerY - tileStore.dragState.offsetY;

  return {
    width: `${width}px`,
    height: `${height}px`,
    left: `${left}px`,
    top: `${top}px`,
  };
});

// Timers for dwell debounce
let mergeTimer: ReturnType<typeof setTimeout> | null = null;
let displaceTimer: ReturnType<typeof setTimeout> | null = null;
let lastHoveredTileId: string | null = null;
let lastDisplaceSlot: string | null = null;

// ---- 文件夹意图识别参数（可调） ----
/** 指针「贴近区」外扩：指针进入此范围即开始累积置信度 */
const FOLDER_PROXIMITY_PADDING = 16;
/** 保持目标稳定的半径：进入该范围就短暂拒绝参与排开（离开后 220ms 恢复） */
const FOLDER_HOLD_RADIUS = 28;
/** 锁定后退出所需的外扩距离（滞回）：进入易、离开难 */
const FOLDER_EXIT_PADDING = 30;
/** 指针已在文件夹内时，仍需的最小重叠比例（避免抓取点偏移造成的假命中） */
const FOLDER_MIN_OVERLAP = 0.15;
/** 候选档阈值：只高亮、保持目标稳定，松手不落夹 */
const FOLDER_CANDIDATE_SCORE = 0.32;
/** 锁定档阈值：松手即落夹 */
const FOLDER_LOCK_SCORE = 0.72;
/** 锁定后退出阈值（滞回） */
const FOLDER_UNLOCK_SCORE = 0.45;
/** 锁定所需最短停留（防快速掠过误锁定） */
const FOLDER_MIN_DWELL_MS = 80;
/** 停留置信度归一化时长 */
const FOLDER_DWELL_NORM_MS = 160;
/** 候选/锁定后目标保持不动的时长（离开后延时恢复参与排开） */
const FOLDER_HOLD_MS = 220;
/** 掉出锁定后的冷却，避免边缘反复横跳 */
const FOLDER_COOLDOWN_MS = 120;

let folderCandidateId: string | null = null;
let folderCandidateSince = 0;
let folderLockCooldownUntil = 0;
/** folderId → 保持原位的截止时间（时间黏性，替代全局钉死） */
const folderHoldUntil = new Map<string, number>();

interface RectLike {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function distanceToRect(px: number, py: number, rect: RectLike): number {
  const dx = Math.max(rect.left - px, 0, px - rect.right);
  const dy = Math.max(rect.top - py, 0, py - rect.bottom);
  return Math.hypot(dx, dy);
}

function isPointInsideRect(px: number, py: number, rect: RectLike, pad = 0): boolean {
  return (
    px >= rect.left - pad &&
    px <= rect.right + pad &&
    py >= rect.top - pad &&
    py <= rect.bottom + pad
  );
}

function holdFolder(id: string, now: number) {
  folderHoldUntil.set(id, now + FOLDER_HOLD_MS);
}

/** 取出当前仍处于黏性窗口内的文件夹 id（用于排开时保持它们不动） */
function collectHeldIds(now: number): Set<string> | undefined {
  if (folderHoldUntil.size === 0) return undefined;
  const held = new Set<string>();
  for (const [id, until] of folderHoldUntil) {
    if (until > now) held.add(id);
    else folderHoldUntil.delete(id);
  }
  return held.size > 0 ? held : undefined;
}

function resetFolderIntent() {
  folderCandidateId = null;
  folderCandidateSince = 0;
  folderLockCooldownUntil = 0;
  folderHoldUntil.clear();
}

interface FolderCandidate {
  tile: TileData;
  rect: RectLike;
  distance: number;
  proximity: number;
  pointerInside: boolean;
  overlap: number;
  /** 不含停留时间的即时得分（0~0.8） */
  baseScore: number;
}

/**
 * 评分模型：指针贴近度 0.45 + 重叠面积 0.35 + 停留时间 0.20
 * 指针优先，解决抓取点偏移导致“指针在文件夹里却不算命中”的问题。
 */
function evaluateFolderCandidate(
  pointerX: number,
  pointerY: number,
  dragRect: RectLike,
  dragArea: number,
  groupRect: DOMRect,
  groupTiles: TileData[],
  dragged: TileData,
  srcFolderId: string | null,
): FolderCandidate | null {
  if (dragged.type !== 'file') return null;

  let best: FolderCandidate | null = null;

  for (const t of groupTiles) {
    if (t.type !== 'folder') continue;
    if (t.id === srcFolderId) continue;

    const span = getTileSpan(t.size, t.customSpan);
    const left = groupRect.left + t.x * (UNIT_SIZE + GRID_GAP);
    const top = groupRect.top + t.y * (UNIT_SIZE + GRID_GAP);
    const width = span.w * UNIT_SIZE + (span.w - 1) * GRID_GAP;
    const height = span.h * UNIT_SIZE + (span.h - 1) * GRID_GAP;
    const rect: RectLike = { left, top, right: left + width, bottom: top + height };

    const distance = distanceToRect(pointerX, pointerY, rect);
    const proximity =
      distance >= FOLDER_PROXIMITY_PADDING ? 0 : 1 - distance / FOLDER_PROXIMITY_PADDING;
    const pointerInside = isPointInsideRect(pointerX, pointerY, rect);

    const overlapW = Math.max(
      0,
      Math.min(dragRect.right, rect.right) - Math.max(dragRect.left, rect.left),
    );
    const overlapH = Math.max(
      0,
      Math.min(dragRect.bottom, rect.bottom) - Math.max(dragRect.top, rect.top),
    );
    const overlap = (overlapW * overlapH) / dragArea;

    if (distance > FOLDER_HOLD_RADIUS && overlap < 0.02) continue;

    const baseScore = 0.45 * proximity + 0.35 * Math.min(1, overlap / 0.4);
    if (!best || baseScore > best.baseScore) {
      best = { tile: t, rect, distance, proximity, pointerInside, overlap, baseScore };
    }
  }

  return best;
}

/**
 * 三档意图状态机：
 * - candidate：只描边、保持目标稳定，松手仍然落到网格
 * - locked：硬高亮、松手入夹
 * - 带退出滞回与冷却，避免边缘反复横跳
 */
function updateFolderIntentState(candidate: FolderCandidate | null, now: number) {
  const ds = tileStore.dragState;

  if (!candidate) {
    folderCandidateId = null;
    if (ds.hoverPhase !== 'none') {
      if (ds.hoverPhase === 'locked') {
        folderLockCooldownUntil = now + FOLDER_COOLDOWN_MS;
      }
      ds.hoverPhase = 'none';
      ds.hoverTargetTileId = null;
      ds.hoverTargetType = null;
      ds.hoverConfidence = 0;
    }
    return;
  }

  if (folderCandidateId !== candidate.tile.id) {
    folderCandidateId = candidate.tile.id;
    folderCandidateSince = now;
  }

  const dwellMs = now - folderCandidateSince;
  const dwellFactor = Math.min(1, dwellMs / FOLDER_DWELL_NORM_MS);
  const score = candidate.baseScore + 0.2 * dwellFactor;

  // 进入目标附近就维持其位置稳定（无需等到候选档），离开 220ms 后恢复参与排开
  if (candidate.distance <= FOLDER_HOLD_RADIUS || score >= FOLDER_CANDIDATE_SCORE) {
    holdFolder(candidate.tile.id, now);
  }

  const lockedId =
    ds.hoverPhase === 'locked' && ds.hoverTargetType === 'folder'
      ? ds.hoverTargetTileId
      : null;

  // 已锁定：滞回保持，需明显离开或分数明显下降才解除
  if (lockedId === candidate.tile.id) {
    const pointerGone =
      distanceToRect(ds.pointerX, ds.pointerY, candidate.rect) > FOLDER_EXIT_PADDING;
    if (score >= FOLDER_UNLOCK_SCORE && !pointerGone) {
      ds.hoverConfidence = score;
      return;
    }

    ds.hoverPhase = 'none';
    ds.hoverTargetTileId = null;
    ds.hoverTargetType = null;
    ds.hoverConfidence = score;
    folderLockCooldownUntil = now + FOLDER_COOLDOWN_MS;
  }

  const canLock =
    now >= folderLockCooldownUntil &&
    ((candidate.pointerInside && candidate.overlap >= FOLDER_MIN_OVERLAP) ||
      (score >= FOLDER_LOCK_SCORE && dwellMs >= FOLDER_MIN_DWELL_MS));

  if (canLock) {
    clearFileDwell();
    ds.hoverPhase = 'locked';
    ds.hoverTargetTileId = candidate.tile.id;
    ds.hoverTargetType = 'folder';
    ds.hoverConfidence = score;
    holdFolder(candidate.tile.id, now);
    return;
  }

  if (score >= FOLDER_CANDIDATE_SCORE) {
    clearFileDwell();
    ds.hoverPhase = 'candidate';
    ds.hoverTargetTileId = candidate.tile.id;
    ds.hoverTargetType = 'folder';
    ds.hoverConfidence = score;
    return;
  }

  if (ds.hoverPhase !== 'none') {
    ds.hoverPhase = 'none';
    ds.hoverTargetTileId = null;
    ds.hoverTargetType = null;
  }
  ds.hoverConfidence = score;
}

function clearFileDwell() {
  if (mergeTimer) {
    clearTimeout(mergeTimer);
    mergeTimer = null;
  }
  lastHoveredTileId = null;
  tileStore.dragState.isMergeReady = false;
}

function clearHoverTarget() {
  clearFileDwell();
  tileStore.dragState.hoverTargetTileId = null;
  tileStore.dragState.hoverTargetType = null;
  tileStore.dragState.hoverPhase = 'none';
  tileStore.dragState.hoverConfidence = 0;
}

/**
 * 候选/锁定时把所有磁贴恢复到真实坐标（取消之前的排开位移），
 * 让用户看到的位置与命中判定使用的坐标完全一致。
 */
function resetDisplacedToOriginals(
  groupTiles: TileData[],
  dragged: TileData,
  ghostX: number,
  ghostY: number,
) {
  const prev = tileStore.dragState.displacedPositions;
  const ghostPos = prev[dragged.id];
  if (ghostPos && ghostPos.x === ghostX && ghostPos.y === ghostY) {
    const allInPlace = groupTiles.every(t => {
      const p = prev[t.id];
      return p && p.x === t.x && p.y === t.y;
    });
    if (allInPlace) return;
  }

  const positions: Record<string, { x: number; y: number }> = {};
  for (const t of groupTiles) {
    positions[t.id] = { x: t.x, y: t.y };
  }
  positions[dragged.id] = { x: ghostX, y: ghostY };
  tileStore.dragState.displacedPositions = positions;
}

/** 文件 → 文件 合成文件夹的 dwell 计时（保留发射前等待） */
function setDwellTarget(target: TileData, dwellMs: number) {
  const ds = tileStore.dragState;
  ds.hoverTargetTileId = target.id;
  ds.hoverTargetType = target.type;
  ds.hoverPhase = 'none';
  ds.hoverConfidence = 0;

  if (lastHoveredTileId === target.id) return;
  lastHoveredTileId = target.id;
  ds.isMergeReady = false;

  if (mergeTimer) clearTimeout(mergeTimer);
  mergeTimer = setTimeout(() => {
    if (tileStore.dragState.isDragging && tileStore.dragState.hoverTargetTileId === target.id) {
      tileStore.dragState.isMergeReady = true;
    }
    mergeTimer = null;
  }, dwellMs);
}

function clearDisplaceTimer() {
  if (displaceTimer) {
    clearTimeout(displaceTimer);
    displaceTimer = null;
  }
  lastDisplaceSlot = null;
}

/**
 * 严密的几何空间分区判定算法：
 * 1. 按 X 轴划分列（Column），消除列与列之间的间隙死区（Dead Zone）
 * 2. 在目标列内按 Y 轴分界线划分分组（Group），消除跨组判定错位
 */
function findTargetGroup(
  tileCenterX: number,
  tileCenterY: number,
): { groupEl: HTMLElement; groupId: string } | null {
  const groupElements = new Map<string, { el: HTMLElement; rect: DOMRect }>();
  const groupEls = Array.from(document.querySelectorAll('[data-group-id]')) as HTMLElement[];
  for (const el of groupEls) {
    const gid = el.getAttribute('data-group-id');
    if (gid) {
      groupElements.set(gid, { el, rect: el.getBoundingClientRect() });
    }
  }

  // Map columns from store to existing DOM elements
  const cols = groupsByColumn.value
    .map(groupList => {
      return groupList
        .map(g => {
          const item = groupElements.get(g.id);
          return item ? { id: g.id, el: item.el, rect: item.rect } : null;
        })
        .filter((item): item is { id: string; el: HTMLElement; rect: DOMRect } => item !== null);
    })
    .filter(col => col.length > 0);

  if (cols.length === 0) return null;

  // 1. Determine target column by horizontal midpoint partitions
  let targetCol = cols[0];
  if (cols.length > 1) {
    for (let i = 0; i < cols.length - 1; i++) {
      const colA = cols[i];
      const colB = cols[i + 1];
      const colARight = Math.max(...colA.map(g => g.rect.right));
      const colBLeft = Math.min(...colB.map(g => g.rect.left));
      const splitX = (colARight + colBLeft) / 2;

      if (tileCenterX < splitX) {
        targetCol = colA;
        break;
      }
      targetCol = colB;
    }
  }

  // 2. In target column, determine target group by vertical midpoint partitions
  if (targetCol.length === 1) {
    return { groupEl: targetCol[0].el, groupId: targetCol[0].id };
  }

  targetCol.sort((a, b) => a.rect.top - b.rect.top);

  let targetGroup = targetCol[0];
  for (let i = 0; i < targetCol.length - 1; i++) {
    const groupA = targetCol[i];
    const groupB = targetCol[i + 1];
    const splitY = (groupA.rect.bottom + groupB.rect.top) / 2;

    if (tileCenterY < splitY) {
      targetGroup = groupA;
      break;
    }
    targetGroup = groupB;
  }

  return { groupEl: targetGroup.el, groupId: targetGroup.id };
}

function beginTileDrag(
  tile: TileData,
  clientX: number,
  clientY: number,
  grabOffset?: { x: number; y: number },
  sourceFolderId: string | null = null,
) {
  const { width, height } = getTilePixelDimensions(tile.size, tile.customSpan);
  const offsetX = grabOffset ? grabOffset.x : width / 2;
  const offsetY = grabOffset ? grabOffset.y : height / 2;

  resetFolderIntent();

  tileStore.dragState = {
    isDragging: true,
    tile,
    sourceGroupId: tile.groupId,
    sourceFolderId,
    currentGroupId: tile.groupId,
    ghostX: tile.x,
    ghostY: tile.y,
    pointerX: clientX,
    pointerY: clientY,
    offsetX,
    offsetY,
    hoverTargetTileId: null,
    hoverTargetType: null,
    hoverPhase: 'none',
    hoverConfidence: 0,
    isMergeReady: false,
    displacedPositions: { [tile.id]: { x: tile.x, y: tile.y } },
  };

  const group = tileStore.groups.find(g => g.id === tile.groupId);
  const maxCols = group?.widthColumns || GROUP_COLUMNS;

  // 从文件夹拖出时，用指针位置立即推算初始落点，避免 ghost 停在文件夹内的旧坐标
  let initialGhostX = tile.x;
  let initialGhostY = tile.y;
  if (sourceFolderId) {
    const groupEl = document.querySelector(`[data-group-id="${tile.groupId}"]`) as HTMLElement | null;
    if (groupEl) {
      const rect = groupEl.getBoundingClientRect();
      const span = getTileSpan(tile.size, tile.customSpan);
      const left = clientX - offsetX;
      const top = clientY - offsetY;
      initialGhostX = Math.max(
        0,
        Math.min(Math.round((left - rect.left) / (UNIT_SIZE + GRID_GAP)), maxCols - span.w),
      );
      initialGhostY = Math.max(0, Math.round((top - rect.top) / (UNIT_SIZE + GRID_GAP)));
      tileStore.dragState.ghostX = initialGhostX;
      tileStore.dragState.ghostY = initialGhostY;
    }
  }

  lastDisplaceSlot = `${tile.groupId}:${initialGhostX}:${initialGhostY}`;

  const groupTiles = tileStore.tilesByGroup.get(tile.groupId) || [];
  tileStore.dragState.displacedPositions = computeDisplacedPositions(
    groupTiles,
    tile,
    initialGhostX,
    initialGhostY,
    maxCols,
  );

  window.addEventListener('pointermove', onGlobalPointerMove);
  window.addEventListener('pointerup', onGlobalPointerUp);
  window.addEventListener('pointercancel', onGlobalPointerUp);
}

function handleTileDragStart(
  event: PointerEvent,
  tile: TileData,
  grabOffset?: { x: number; y: number },
) {
  beginTileDrag(tile, event.clientX, event.clientY, grabOffset);
}

/**
 * 文件夹弹窗内按住卡片拖出：弹窗立即关闭，拖拽会话交给磁贴板接管，
 * 松手时即可落在任意分组的网格位或另一个文件夹上。
 */
watch(
  () => tileStore.pendingFolderChildDrag,
  pending => {
    if (!pending) return;
    const { file, folder, clientX, clientY } = pending;
    tileStore.pendingFolderChildDrag = null;
    tileStore.closeFolder();
    // 指针近乎位于磁贴中心（尺寸由 1x1 → 2x2 已在上游统一），居中跟随更自然
    beginTileDrag(file, clientX, clientY, undefined, folder.id);
  },
  { flush: 'sync' },
);

function onGlobalPointerMove(event: PointerEvent) {
  if (!tileStore.dragState.isDragging || !tileStore.dragState.tile) return;

  tileStore.dragState.pointerX = event.clientX;
  tileStore.dragState.pointerY = event.clientY;

  checkAutoScroll(event.clientX, event.clientY);

  const tileDim = getTilePixelDimensions(tileStore.dragState.tile.size, tileStore.dragState.tile.customSpan);
  const tileLeft = event.clientX - tileStore.dragState.offsetX;
  const tileTop = event.clientY - tileStore.dragState.offsetY;
  const tileCenterX = tileLeft + tileDim.width / 2;
  const tileCenterY = tileTop + tileDim.height / 2;

  // Accurate geometric partitioning target finding
  const targetGroup = findTargetGroup(tileCenterX, tileCenterY);

  if (targetGroup) {
    const { groupEl, groupId } = targetGroup;
    tileStore.dragState.currentGroupId = groupId;

    const group = tileStore.groups.find(g => g.id === groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;

    const groupRect = groupEl.getBoundingClientRect();
    const relX = tileLeft - groupRect.left;
    const relY = tileTop - groupRect.top;

    const span = getTileSpan(tileStore.dragState.tile.size, tileStore.dragState.tile.customSpan);
    const col = Math.max(0, Math.min(Math.round(relX / (UNIT_SIZE + GRID_GAP)), maxCols - span.w));
    const row = Math.max(0, Math.round(relY / (UNIT_SIZE + GRID_GAP)));

    tileStore.dragState.ghostX = col;
    tileStore.dragState.ghostY = row;

    const groupTiles = tileStore.tilesByGroup.get(groupId) || [];
    const dragged = tileStore.dragState.tile;
    const srcFolderId = tileStore.dragState.sourceFolderId;
    const now = performance.now();

    const dragRect = {
      left: tileLeft,
      top: tileTop,
      right: tileLeft + tileDim.width,
      bottom: tileTop + tileDim.height,
    };
    const dragArea = Math.max(1, tileDim.width * tileDim.height);

    // --- 1. 文件夹意图置信度（三档：none / candidate / locked） ---
    const folderCandidate = evaluateFolderCandidate(
      event.clientX,
      event.clientY,
      dragRect,
      dragArea,
      groupRect,
      groupTiles,
      dragged,
      srcFolderId,
    );
    updateFolderIntentState(folderCandidate, now);

    if (tileStore.dragState.hoverPhase !== 'none' && folderCandidate) {
      // 候选/锁定时把 ghost 吸附到目标文件夹槽位，避免网格取整把它挤到隔壁
      tileStore.dragState.ghostX = folderCandidate.tile.x;
      tileStore.dragState.ghostY = folderCandidate.tile.y;
      // 取消之前的排开位移：目标不再被挤走，视觉位置与判定坐标一致
      resetDisplacedToOriginals(groupTiles, dragged, folderCandidate.tile.x, folderCandidate.tile.y);
      clearDisplaceTimer();
      lastDisplaceSlot = `${groupId}:${folderCandidate.tile.x}:${folderCandidate.tile.y}`;
      return;
    }

    // --- 2. 文件 → 文件 合成文件夹（保持中心对正 500ms） ---
    let fileTarget: TileData | null = null;
    let fileTargetDistance = Number.POSITIVE_INFINITY;

    if (dragged.type === 'file' && !srcFolderId) {
      for (const t of groupTiles) {
        if (t.type !== 'file' || t.id === dragged.id) continue;

        const tSpan = getTileSpan(t.size, t.customSpan);
        const tLeft = groupRect.left + t.x * (UNIT_SIZE + GRID_GAP);
        const tTop = groupRect.top + t.y * (UNIT_SIZE + GRID_GAP);
        const tWidth = tSpan.w * UNIT_SIZE + (tSpan.w - 1) * GRID_GAP;
        const tHeight = tSpan.h * UNIT_SIZE + (tSpan.h - 1) * GRID_GAP;

        const dist = Math.hypot(
          tileCenterX - (tLeft + tWidth / 2),
          tileCenterY - (tTop + tHeight / 2),
        );
        const centerThreshold = Math.min(32, Math.min(tWidth, tHeight) * 0.4);
        if (dist <= centerThreshold && dist < fileTargetDistance) {
          fileTargetDistance = dist;
          fileTarget = t;
        }
      }
    }

    if (fileTarget) {
      setDwellTarget(fileTarget, 500);
      return;
    }

    // --- 3. 自由拖动：保持网格排开嵌入 ---
    clearHoverTarget();

    const slotKey = `${groupId}:${col}:${row}`;
    if (slotKey !== lastDisplaceSlot) {
      lastDisplaceSlot = slotKey;
      if (displaceTimer) clearTimeout(displaceTimer);

      displaceTimer = setTimeout(() => {
        if (!tileStore.dragState.isDragging || !tileStore.dragState.tile) return;
        const heldIds = collectHeldIds(performance.now());
        tileStore.dragState.displacedPositions = computeDisplacedPositions(
          groupTiles,
          tileStore.dragState.tile,
          col,
          row,
          maxCols,
          heldIds,
        );
      }, 120);
    }
  }
}

function onGlobalPointerUp() {
  if (!tileStore.dragState.isDragging || !tileStore.dragState.tile) {
    cleanupDrag();
    return;
  }

  if (displaceTimer) {
    clearTimeout(displaceTimer);
    displaceTimer = null;
  }

  const {
    tile,
    currentGroupId,
    ghostX,
    ghostY,
    hoverTargetTileId,
    hoverTargetType,
    hoverPhase,
    isMergeReady,
    sourceFolderId,
  } = tileStore.dragState;

  let dropX = ghostX;
  let dropY = ghostY;

  // 候选档时 ghost 曾吸附到文件夹槽位，松手需回到指针实际位置，避免叠在文件夹上
  if (hoverPhase === 'candidate' && currentGroupId) {
    const groupEl = document.querySelector(`[data-group-id="${currentGroupId}"]`) as HTMLElement | null;
    if (groupEl) {
      const group = tileStore.groups.find(g => g.id === currentGroupId);
      const maxCols = group?.widthColumns || GROUP_COLUMNS;
      const rect = groupEl.getBoundingClientRect();
      const span = getTileSpan(tile.size, tile.customSpan);
      const left = tileStore.dragState.pointerX - tileStore.dragState.offsetX;
      const top = tileStore.dragState.pointerY - tileStore.dragState.offsetY;
      dropX = Math.max(
        0,
        Math.min(Math.round((left - rect.left) / (UNIT_SIZE + GRID_GAP)), maxCols - span.w),
      );
      dropY = Math.max(0, Math.round((top - rect.top) / (UNIT_SIZE + GRID_GAP)));
    }
  }

  // 1. 仅「锁定」档才允许落入文件夹（候选档只提示不吞）
  if (
    tile.type === 'file' &&
    hoverPhase === 'locked' &&
    hoverTargetType === 'folder' &&
    hoverTargetTileId
  ) {
    if (sourceFolderId) {
      if (sourceFolderId !== hoverTargetTileId) {
        tileStore.moveFileBetweenFolders(sourceFolderId, tile.id, hoverTargetTileId);
      } else {
        // 拖回自己所在的文件夹：视为取消，重新打开原文件夹
        const sameFolder = tileStore.tiles.find(t => t.id === sourceFolderId);
        if (sameFolder && sameFolder.type === 'folder') {
          tileStore.openFolder(sameFolder);
        }
      }
    } else {
      tileStore.addFileToFolder(hoverTargetTileId, tile.id);
    }
    cleanupDrag();
    return;
  }

  // 2. 文件 → 文件 合并成文件夹（需持续正对中心 dwell 完成）
  if (
    isMergeReady &&
    tile.type === 'file' &&
    !sourceFolderId &&
    hoverTargetType === 'file' &&
    hoverTargetTileId &&
    hoverTargetTileId !== tile.id
  ) {
    tileStore.createFolderFromFiles(tile.id, hoverTargetTileId);
    cleanupDrag();
    return;
  }

  // 3. 从文件夹拖出到磁贴板网格（含拖到其它分组）
  if (sourceFolderId && currentGroupId) {
    const group = tileStore.groups.find(g => g.id === currentGroupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const groupTiles = tileStore.tilesByGroup.get(currentGroupId) || [];
    const finalDisplaced = computeDisplacedPositions(groupTiles, tile, dropX, dropY, maxCols);
    tileStore.applyDisplacedPositions(currentGroupId, finalDisplaced);
    tileStore.removeFileFromFolder(sourceFolderId, tile.id, currentGroupId, dropX, dropY);
    cleanupDrag();
    return;
  }

  // 4. 普通网格落位（排开并嵌入 ghost 槽位；候选已退场，文件夹正常让位）
  if (currentGroupId) {
    if (tileStore.dragState.sourceGroupId && tileStore.dragState.sourceGroupId !== currentGroupId) {
      tile.groupId = currentGroupId;
    }

    const group = tileStore.groups.find(g => g.id === currentGroupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const groupTiles = tileStore.tilesByGroup.get(currentGroupId) || [];
    const finalDisplaced = computeDisplacedPositions(groupTiles, tile, dropX, dropY, maxCols);
    tileStore.applyDisplacedPositions(currentGroupId, finalDisplaced);

    tileStore.moveTile(tile.id, currentGroupId, dropX, dropY);
    cleanupDrag();
    return;
  }

  // 5. 从文件夹拖出但落在板外：重新打开文件夹，避免文件“凭空消失”
  if (sourceFolderId) {
    const sourceFolder = tileStore.tiles.find(t => t.id === sourceFolderId);
    if (sourceFolder && sourceFolder.type === 'folder') {
      tileStore.openFolder(sourceFolder);
    }
  }

  cleanupDrag();
}

function cleanupDrag() {
  clearHoverTarget();
  clearDisplaceTimer();
  resetFolderIntent();
  tileStore.dragState = {
    isDragging: false,
    tile: null,
    sourceGroupId: null,
    sourceFolderId: null,
    currentGroupId: null,
    ghostX: 0,
    ghostY: 0,
    pointerX: 0,
    pointerY: 0,
    offsetX: 0,
    offsetY: 0,
    hoverTargetTileId: null,
    hoverTargetType: null,
    hoverPhase: 'none',
    hoverConfidence: 0,
    isMergeReady: false,
    displacedPositions: {},
  };

  window.removeEventListener('pointermove', onGlobalPointerMove);
  window.removeEventListener('pointerup', onGlobalPointerUp);
  window.removeEventListener('pointercancel', onGlobalPointerUp);
}

// Whole Group Dragging & Reordering
const draggedGroup = computed(() => {
  if (!tileStore.groupDragState.isDragging || !tileStore.groupDragState.groupId) return null;
  return tileStore.groups.find(g => g.id === tileStore.groupDragState.groupId) || null;
});

function handleGroupDragStart(event: PointerEvent, group: TileGroupData) {
  tileStore.groupDragState = {
    isDragging: true,
    groupId: group.id,
    targetGroupId: null,
    dropPosition: null,
    dropMode: 'reorder',
    targetColumnIndex: null,
    pointerX: event.clientX,
    pointerY: event.clientY,
  };

  const onGroupPointerMove = (moveEvent: PointerEvent) => {
    tileStore.groupDragState.pointerX = moveEvent.clientX;
    tileStore.groupDragState.pointerY = moveEvent.clientY;

    checkAutoScroll(moveEvent.clientX, moveEvent.clientY);

    // 1. Detect if dragging outwards or between columns to create/insert a new column
    const colEls = Array.from(
      document.querySelectorAll('[data-board-column-index]')
    ) as HTMLElement[];

    const colRects = colEls.map(el => {
      const idx = parseInt(el.getAttribute('data-board-column-index') || '0', 10);
      return { idx, rect: el.getBoundingClientRect() };
    });

    let detectedNewCol: number | null = null;

    if (colRects.length > 0) {
      const firstCol = colRects[0];
      const lastCol = colRects[colRects.length - 1];

      // To the right of the outermost column (向最外侧拖出新分栏)
      if (moveEvent.clientX > lastCol.rect.right - 10) {
        detectedNewCol = colRects.length;
      }
      // To the left of the first column
      else if (moveEvent.clientX < firstCol.rect.left - 15) {
        detectedNewCol = 0;
      }
      // In the gap between existing columns
      else {
        for (let i = 0; i < colRects.length - 1; i++) {
          const rightA = colRects[i].rect.right;
          const leftB = colRects[i + 1].rect.left;
          if (moveEvent.clientX >= rightA - 12 && moveEvent.clientX <= leftB + 12) {
            detectedNewCol = i + 1;
            break;
          }
        }
      }
    }

    if (detectedNewCol !== null) {
      tileStore.groupDragState.dropMode = 'new-column';
      tileStore.groupDragState.targetColumnIndex = detectedNewCol;
      tileStore.groupDragState.targetGroupId = null;
      tileStore.groupDragState.dropPosition = null;
      return;
    }

    // 2. Otherwise, check group container for reordering within column
    tileStore.groupDragState.dropMode = 'reorder';
    tileStore.groupDragState.targetColumnIndex = null;

    const containerEls = Array.from(
      document.querySelectorAll('[data-group-container-id]')
    ) as HTMLElement[];

    let hoveredContainer: HTMLElement | null = null;
    for (const el of containerEls) {
      const rect = el.getBoundingClientRect();
      if (
        moveEvent.clientX >= rect.left - 30 &&
        moveEvent.clientX <= rect.right + 30 &&
        moveEvent.clientY >= rect.top - 20 &&
        moveEvent.clientY <= rect.bottom + 20
      ) {
        hoveredContainer = el;
        break;
      }
    }

    if (hoveredContainer) {
      const targetId = hoveredContainer.getAttribute('data-group-container-id')!;
      const rect = hoveredContainer.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const pos = moveEvent.clientY < midY ? 'before' : 'after';

      tileStore.groupDragState.targetGroupId = targetId;
      tileStore.groupDragState.dropPosition = pos;
    } else {
      tileStore.groupDragState.targetGroupId = null;
      tileStore.groupDragState.dropPosition = null;
    }
  };

  const onGroupPointerUp = () => {
    window.removeEventListener('pointermove', onGroupPointerMove);
    window.removeEventListener('pointerup', onGroupPointerUp);
    window.removeEventListener('pointercancel', onGroupPointerUp);

    const { groupId, targetGroupId, dropPosition, dropMode, targetColumnIndex } = tileStore.groupDragState;
    if (groupId) {
      if (dropMode === 'new-column' && targetColumnIndex !== null && targetColumnIndex !== undefined) {
        tileStore.moveGroupToNewColumn(groupId, targetColumnIndex);
      } else if (targetGroupId && dropPosition && groupId !== targetGroupId) {
        tileStore.reorderGroup(groupId, targetGroupId, dropPosition);
      }
    }

    tileStore.groupDragState = {
      isDragging: false,
      groupId: null,
      targetGroupId: null,
      dropPosition: null,
      dropMode: 'reorder',
      targetColumnIndex: null,
      pointerX: 0,
      pointerY: 0,
    };
  };

  window.addEventListener('pointermove', onGroupPointerMove);
  window.addEventListener('pointerup', onGroupPointerUp);
  window.addEventListener('pointercancel', onGroupPointerUp);
}

function handleBoardContextMenu(event: MouseEvent) {
  event.preventDefault();
  tileStore.openContextMenu(event.clientX, event.clientY, null, undefined, true);
}

onUnmounted(() => {
  cleanupDrag();
});
</script>

<template>
  <div
    ref="boardRef"
    class="relative h-full w-full overflow-x-auto overflow-y-auto px-8 py-6 select-none tile-board-scroll"
    @contextmenu.self="handleBoardContextMenu"
  >
    <!-- Multi-Column Layout (Matching Windows 10 Start Menu Columns with Dynamic Widths) -->
    <div
      class="flex items-start gap-8 min-w-max pb-16"
      @contextmenu.self="handleBoardContextMenu"
    >
      <!-- Vertical Drop Indicator Before First Column -->
      <div
        v-if="tileStore.groupDragState.isDragging && tileStore.groupDragState.dropMode === 'new-column' && tileStore.groupDragState.targetColumnIndex === 0"
        class="flex flex-col items-center justify-center min-h-[300px] w-8 shrink-0 self-start animate-pulse"
      >
        <div class="h-full w-1 rounded-full bg-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.9)]" />
        <span class="mt-2 text-[10px] whitespace-nowrap bg-sky-500 px-2 py-0.5 rounded text-white font-medium shadow-md">
          新建第一栏
        </span>
      </div>

      <template v-for="(colGroups, colIndex) in groupsByColumn" :key="`col-wrap-${colIndex}`">
        <!-- Vertical Drop Indicator Between Columns -->
        <div
          v-if="colIndex > 0 && tileStore.groupDragState.isDragging && tileStore.groupDragState.dropMode === 'new-column' && tileStore.groupDragState.targetColumnIndex === colIndex"
          class="flex flex-col items-center justify-center min-h-[300px] w-8 shrink-0 self-start animate-pulse"
        >
          <div class="h-full w-1 rounded-full bg-sky-400 shadow-[0_0_14px_rgba(56,189,248,0.9)]" />
          <span class="mt-2 text-[10px] whitespace-nowrap bg-sky-500 px-2 py-0.5 rounded text-white font-medium shadow-md">
            插入分栏
          </span>
        </div>

        <div
          :data-board-column-index="colIndex"
          class="flex flex-col transition-[min-width] duration-150"
          :style="{
            minWidth: `${colGroups.length > 0 ? Math.max(
              ...colGroups.map(g => (g.widthColumns || 6) * (UNIT_SIZE + GRID_GAP) - GRID_GAP)
            ) : 0}px`,
          }"
          @contextmenu.self="handleBoardContextMenu"
        >
          <template v-for="group in colGroups" :key="group.id">
            <TileGroupContainer
              :group="group"
              :tiles="tileStore.tilesByGroup.get(group.id) || []"
              @dragstart="handleTileDragStart"
              @group-drag-start="handleGroupDragStart"
            />
          </template>
        </div>
      </template>

      <!-- Outward Drop Zone Card at Far Right (向外拖动创建独立新栏) -->
      <div
        v-if="tileStore.groupDragState.isDragging"
        class="flex flex-col items-center justify-center min-h-[260px] w-64 shrink-0 rounded border-2 border-dashed transition-all duration-200 select-none p-5 self-start cursor-pointer"
        :class="[
          tileStore.groupDragState.dropMode === 'new-column' && tileStore.groupDragState.targetColumnIndex === groupsByColumn.length
            ? 'border-sky-400 bg-sky-500/20 shadow-[0_0_24px_rgba(56,189,248,0.4)] text-sky-300 scale-[1.02]'
            : 'border-white/15 bg-white/[0.03] text-white/40 hover:border-white/25'
        ]"
      >
        <div
          class="flex size-11 items-center justify-center rounded-full border transition-all mb-2.5"
          :class="[
            tileStore.groupDragState.dropMode === 'new-column' && tileStore.groupDragState.targetColumnIndex === groupsByColumn.length
              ? 'bg-sky-500/30 border-sky-400 text-sky-300'
              : 'bg-white/5 border-white/10 text-white/40'
          ]"
        >
          <Plus class="size-5" />
        </div>
        <p class="text-xs font-semibold text-white/95">新建独立分栏</p>
        <p class="text-[11px] text-white/50 mt-1 text-center">向外拖至此处，独立成栏</p>
      </div>
    </div>

    <!-- Floating Drag Preview Attached Precisely to Cursor (is-preview disables inner transforms) -->
    <div
      v-if="dragPreviewStyle && tileStore.dragState.tile"
      class="pointer-events-none fixed z-[9999] opacity-95 shadow-2xl"
      :style="dragPreviewStyle"
    >
      <FolderTile
        v-if="tileStore.dragState.tile.type === 'folder'"
        :folder="tileStore.dragState.tile"
        :is-preview="true"
      />
      <FileTile
        v-else
        :file="tileStore.dragState.tile"
        :is-preview="true"
      />
    </div>

    <!-- Floating Group Drag Preview (When dragging whole group) -->
    <div
      v-if="tileStore.groupDragState.isDragging && draggedGroup"
      class="pointer-events-none fixed z-[9999] opacity-95 shadow-2xl rounded-md border border-sky-400/50 bg-[#0f172a]/90 backdrop-blur-xl px-4 py-2 text-white flex items-center gap-2.5"
      :style="{
        left: `${tileStore.groupDragState.pointerX + 15}px`,
        top: `${tileStore.groupDragState.pointerY + 15}px`,
      }"
    >
      <GripVertical class="size-4 text-sky-400" />
      <div>
        <p class="text-xs font-semibold text-white/95">{{ draggedGroup.title }}</p>
        <p
          class="text-[10px] font-medium"
          :class="tileStore.groupDragState.dropMode === 'new-column' ? 'text-sky-300 font-semibold animate-pulse' : 'text-white/60'"
        >
          {{ tileStore.groupDragState.dropMode === 'new-column' ? '松开以新建独立分栏' : '正在调整分组位置' }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Windows 10 Fluent Style Scrollbars */
.tile-board-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

.tile-board-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.tile-board-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.tile-board-scroll::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}

.tile-board-scroll::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.4);
  border: 2px solid transparent;
  background-clip: padding-box;
}

.tile-board-scroll::-webkit-scrollbar-corner {
  background: transparent;
}
</style>
