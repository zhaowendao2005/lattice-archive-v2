/**
 * [UTIL] 客户端探索页与治理清单 CRDT 三路合并引擎 (LWW-Element-Set + Tombstones)
 * 注意：严禁对可能来自 Vue 3 ref/reactive 的 Proxy 对象直接调用 window.structuredClone（会抛 DataCloneError），
 * 统一使用基于 JSON 的深拷贝并剥离仅当前标签页有效的 blob: objectUrl。
 */
import type { ExploreManifestV2, TempSessionCredential } from '../types';
import { migrateExploreManifestV2ToV3 } from './resourceManifest';
import type { FileTileData, FolderTileData, TileData, TileGroupData } from '@/views/main/archive/types/tile';

function clonePlain<T>(val: T): T {
  return JSON.parse(JSON.stringify(val)) as T;
}

function sanitizeTileThumb(tile: TileData): TileData {
  const cloned = clonePlain(tile);
  if (cloned.thumb?.objectUrl?.startsWith('blob:')) {
    delete cloned.thumb.objectUrl;
  }
  if (cloned.type === 'folder' && Array.isArray(cloned.children)) {
    cloned.children = cloned.children.map((c) => sanitizeTileThumb(c) as FileTileData | FolderTileData);
  }
  return cloned;
}

function collectFolderChildTimestamps(
  list: TileData[],
  out: Map<string, number> = new Map(),
): Map<string, number> {
  for (const item of list) {
    if (item.type === 'folder') {
      const folderTs = item.updatedAtMs ?? 0;
      for (const child of item.children) {
        const ts = Math.max(folderTs, child.updatedAtMs ?? 0);
        out.set(child.id, Math.max(out.get(child.id) ?? 0, ts));
      }
      collectFolderChildTimestamps(item.children, out);
    }
  }
  return out;
}

function mergeRecursiveFolderChildren(
  localChildren: (FileTileData | FolderTileData)[],
  remoteChildren: (FileTileData | FolderTileData)[],
  tombstones: Record<string, number>,
): (FileTileData | FolderTileData)[] {
  const byId = new Map<string, FileTileData | FolderTileData>();

  for (const item of remoteChildren) {
    if (tombstones[item.id]) continue;
    byId.set(item.id, sanitizeTileThumb(item) as FileTileData | FolderTileData);
  }

  for (const localItem of localChildren) {
    if (tombstones[localItem.id]) continue;
    const existing = byId.get(localItem.id);
    if (!existing) {
      byId.set(localItem.id, sanitizeTileThumb(localItem) as FileTileData | FolderTileData);
      continue;
    }
    const localTs = localItem.updatedAtMs ?? 0;
    const remoteTs = existing.updatedAtMs ?? 0;
    if (localItem.type === 'folder' && existing.type === 'folder') {
      const winner = localTs >= remoteTs ? localItem : existing;
      const mergedFolder: FolderTileData = {
        ...(sanitizeTileThumb(winner) as FolderTileData),
        children: mergeRecursiveFolderChildren(localItem.children, existing.children, tombstones),
      };
      byId.set(localItem.id, mergedFolder);
    } else {
      const winner = localTs >= remoteTs ? localItem : existing;
      byId.set(localItem.id, sanitizeTileThumb(winner) as FileTileData | FolderTileData);
    }
  }

  return Array.from(byId.values());
}

function mergeTopLevelTiles(
  localTiles: TileData[],
  remoteTiles: TileData[],
  tombstones: Record<string, number>,
): TileData[] {
  const byId = new Map<string, TileData>();

  for (const t of remoteTiles) {
    if (!t.systemApp && tombstones[t.id]) continue;
    byId.set(t.id, sanitizeTileThumb(t));
  }

  for (const localTile of localTiles) {
    if (!localTile.systemApp && tombstones[localTile.id]) continue;
    const existing = byId.get(localTile.id);
    if (!existing) {
      byId.set(localTile.id, sanitizeTileThumb(localTile));
      continue;
    }
    const localTs = localTile.updatedAtMs ?? 0;
    const remoteTs = existing.updatedAtMs ?? 0;
    if (localTile.type === 'folder' && existing.type === 'folder') {
      const winner = localTs >= remoteTs ? localTile : existing;
      byId.set(localTile.id, {
        ...(sanitizeTileThumb(winner) as FolderTileData),
        children: mergeRecursiveFolderChildren(localTile.children, existing.children, tombstones),
      });
    } else if (localTile.systemApp && existing.systemApp) {
      // 常驻系统磁贴：若远端已有自定义坐标或更新时间，优先保留远端或显式更新时间更新的一方
      const winner = remoteTs >= localTs ? existing : localTile;
      byId.set(localTile.id, sanitizeTileThumb(winner));
    } else {
      const winner = localTs >= remoteTs ? localTile : existing;
      byId.set(localTile.id, sanitizeTileThumb(winner));
    }
  }

  const mergedList = Array.from(byId.values());
  // 若某个磁贴已被移入文件夹中，且文件夹内的时间戳 >= 顶层时间戳，则从顶层去重移除
  const childTsMap = collectFolderChildTimestamps(mergedList);
  return mergedList.filter((t) => {
    if (t.type === 'folder' || t.systemApp) return true;
    const childTs = childTsMap.get(t.id);
    if (childTs === undefined) return true;
    return (t.updatedAtMs ?? 0) > childTs;
  });
}

export function mergeExploreManifestsCrdt(
  localInput: ExploreManifestV2,
  remoteInput: ExploreManifestV2,
): ExploreManifestV2 {
  const local = migrateExploreManifestV2ToV3(localInput);
  const remote = migrateExploreManifestV2ToV3(remoteInput);
  const mergedTombstones: Record<string, number> = { ...(remote.tombstones ?? {}) };
  for (const [id, ts] of Object.entries(local.tombstones ?? {})) {
    mergedTombstones[id] = Math.max(mergedTombstones[id] ?? 0, ts);
  }

  // 合并分组：只有当本地分组自身拥有显式 updatedAtMs 且 >= 远端分组 updatedAtMs 时才优先本地，
  // 防止新设备首次打开生成的默认分组覆盖设备一的分组配置
  const groupMap = new Map<string, TileGroupData>();
  for (const rg of remote.groups ?? []) {
    if (mergedTombstones[rg.id]) continue;
    groupMap.set(rg.id, clonePlain(rg));
  }

  for (const lg of local.groups ?? []) {
    if (mergedTombstones[lg.id]) continue;
    const existing = groupMap.get(lg.id);
    if (!existing) {
      groupMap.set(lg.id, clonePlain(lg));
    } else {
      const localGroupTs = lg.updatedAtMs ?? 0;
      const remoteGroupTs = existing.updatedAtMs ?? remote.updatedAtMs ?? 0;
      const preferLocal = localGroupTs > 0 && localGroupTs >= remoteGroupTs;
      groupMap.set(lg.id, clonePlain(preferLocal ? lg : existing));
    }
  }

  // 合并顶层与递归文件夹磁贴
  const mergedTiles = mergeTopLevelTiles(local.tiles ?? [], remote.tiles ?? [], mergedTombstones);

  // 合并临时凭据池
  const credMap = new Map<string, TempSessionCredential>();
  for (const rc of remote.tempCredentials ?? []) {
    if (mergedTombstones[rc.id]) continue;
    credMap.set(rc.id, clonePlain(rc));
  }
  for (const lc of local.tempCredentials ?? []) {
    if (mergedTombstones[lc.id]) continue;
    const existing = credMap.get(lc.id);
    if (!existing || (lc.lastVerifiedAt ?? 0) >= (existing.lastVerifiedAt ?? 0)) {
      credMap.set(lc.id, clonePlain(lc));
    }
  }

  const localIsNewer = (local.updatedAtMs ?? 0) > (remote.updatedAtMs ?? 0);
  const resourceMap = new Map(Object.entries(remote.resources ?? {}).filter(([id]) => !mergedTombstones[`resource:${id}`]));
  for (const [id, resource] of Object.entries(local.resources ?? {})) {
    if (mergedTombstones[`resource:${id}`]) continue;
    const existing = resourceMap.get(id);
    if (!existing || resource.updatedAtMs >= existing.updatedAtMs) {
      resourceMap.set(id, clonePlain(resource));
    } else if (resource.sources?.length && existing.sources?.length) {
      const merged = new Map([...existing.sources, ...resource.sources].map((source) => [JSON.stringify(source), source]));
      resourceMap.set(id, { ...existing, sources: Array.from(merged.values()) });
    }
  }

  return {
    schemaVersion: 3,
    revision: Math.max(local.revision ?? 0, remote.revision ?? 0),
    updatedAtMs: Math.max(local.updatedAtMs ?? 0, remote.updatedAtMs ?? 0, Date.now()),
    deviceId: local.deviceId || remote.deviceId || 'unknown',
    groups: Array.from(groupMap.values()).sort((a, b) => a.column - b.column || a.order - b.order),
    tiles: mergedTiles,
    resources: Object.fromEntries(resourceMap),
    tombstones: mergedTombstones,
    tempCredentials: Array.from(credMap.values()),
    quotaPolicy: localIsNewer
      ? clonePlain(local.quotaPolicy ?? remote.quotaPolicy)
      : clonePlain(remote.quotaPolicy ?? local.quotaPolicy),
    vaultConfig: localIsNewer
      ? clonePlain(local.vaultConfig ?? remote.vaultConfig)
      : clonePlain(remote.vaultConfig ?? local.vaultConfig),
  };
}
