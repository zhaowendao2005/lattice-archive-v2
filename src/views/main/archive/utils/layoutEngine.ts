import type { TileData } from '../types/tile';
import { getTileSpan, GROUP_COLUMNS } from '../store/tileStore';

export function computeDisplacedPositions(
  groupTiles: TileData[],
  draggedTile: TileData | null,
  ghostX: number,
  ghostY: number,
  maxColumns: number = GROUP_COLUMNS,
  heldIds?: ReadonlySet<string>,
): Record<string, { x: number; y: number }> {
  const result: Record<string, { x: number; y: number }> = {};

  if (!draggedTile) {
    for (const t of groupTiles) {
      result[t.id] = { x: t.x, y: t.y };
    }
    return result;
  }

  const dragSpan = getTileSpan(draggedTile.size, draggedTile.customSpan);
  const maxCols = maxColumns;

  // 2D grid matrix
  const grid: (string | null)[][] = [];

  function ensureRow(r: number) {
    while (grid.length <= r) {
      grid.push(new Array(maxCols).fill(null));
    }
  }

  function isAreaFree(x: number, y: number, w: number, h: number): boolean {
    if (x + w > maxCols) return false;
    for (let r = y; r < y + h; r++) {
      ensureRow(r);
      for (let c = x; c < x + w; c++) {
        if (grid[r][c] !== null) return false;
      }
    }
    return true;
  }

  function markArea(id: string, x: number, y: number, w: number, h: number) {
    for (let r = y; r < y + h; r++) {
      ensureRow(r);
      for (let c = x; c < x + w; c++) {
        grid[r][c] = id;
      }
    }
  }

  // 1. Reserve ghost slot for the dragged tile
  markArea('__ghost__', ghostX, ghostY, dragSpan.w, dragSpan.h);
  result[draggedTile.id] = { x: ghostX, y: ghostY };

  const otherTiles = groupTiles.filter(t => t.id !== draggedTile.id);

  // 2. Pin held tiles (候选/锁定的文件夹) at their current spot so they stop fleeing the pointer
  if (heldIds && heldIds.size > 0) {
    for (const tile of otherTiles) {
      if (!heldIds.has(tile.id)) continue;
      const span = getTileSpan(tile.size, tile.customSpan);
      markArea(tile.id, tile.x, tile.y, span.w, span.h);
      result[tile.id] = { x: tile.x, y: tile.y };
    }
  }

  // 3. Sort the remaining tiles in group in reading order (by y, then by x)
  const otherTilesSorted = otherTiles
    .filter(t => !heldIds?.has(t.id))
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // 4. Place other tiles
  for (const tile of otherTilesSorted) {
    const span = getTileSpan(tile.size, tile.customSpan);

    // Can it stay at original spot?
    if (isAreaFree(tile.x, tile.y, span.w, span.h)) {
      markArea(tile.id, tile.x, tile.y, span.w, span.h);
      result[tile.id] = { x: tile.x, y: tile.y };
    } else {
      // Find nearest gap/opening starting from min(tile.y, ghostY)
      let placed = false;
      const startRow = Math.max(0, Math.min(tile.y, ghostY));
      for (let r = startRow; r < 200 && !placed; r++) {
        for (let c = 0; c <= maxCols - span.w; c++) {
          if (isAreaFree(c, r, span.w, span.h)) {
            markArea(tile.id, c, r, span.w, span.h);
            result[tile.id] = { x: c, y: r };
            placed = true;
            break;
          }
        }
      }
      if (!placed) {
        result[tile.id] = { x: tile.x, y: tile.y + dragSpan.h };
      }
    }
  }

  return result;
}
