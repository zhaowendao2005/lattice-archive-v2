/**
 * ============================================================================
 * 五大本地存储子域配额管理与自适应淘汰引擎 (Storage Quota & Eviction Engine)
 * ============================================================================
 * 子域划分（与架构规范 §2.4 严格对齐）：
 * 1. core-metadata         (50MB，永不自动淘汰)
 * 2. explore-thumbs        (默认 256MB，可调 64MB~1GB，孤儿引用清扫 + LRU)
 * 3. chat-media-cache      (默认 512MB，可调 128MB~2GB，TTL 7天 + LRU)
 * 4. search-stream-buffer  (默认 384MB，可调 128MB~1GB，Ring-Buffer FIFO 滑动窗口)
 * 5. explore-offline-blobs (默认 2048MB，可调 512MB~10GB，钉选保护 + 非钉选 LRU)
 */
import type {
  StorageSubDomainId,
  StorageSubDomainQuota,
} from '@/stores/archive/types';
import { opfsExploreStorage } from './opfsExploreStorage';

const QUOTA_CONFIG_STORAGE_KEY = 'lattice_storage_subdomain_quotas_v2';
const CHAT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const DEFAULT_SUBDOMAIN_QUOTAS: Record<StorageSubDomainId, StorageSubDomainQuota> = {
  'core-metadata': {
    id: 'core-metadata',
    title: '核心元数据与登录凭证',
    description: 'AES-GCM-256 会话保险库、账号治理状态机与 Explore 拓扑清单',
    storageLocation: 'IndexedDB + OPFS /explore-manifest.v2.json',
    defaultLimitMB: 50,
    minLimitMB: 50,
    maxLimitMB: 200,
    configuredLimitMB: 50,
    usedBytes: 0,
    itemCount: 1,
    evictionPolicy: 'never',
  },
  'explore-thumbs': {
    id: 'explore-thumbs',
    title: 'Explore 磁贴缩略图池',
    description: '磁贴与文件夹的持久化高清 WebP 缩略图（/thumbs/{tileId}.webp）',
    storageLocation: 'OPFS /thumbs/*',
    defaultLimitMB: 256,
    minLimitMB: 64,
    maxLimitMB: 1024,
    configuredLimitMB: 256,
    usedBytes: 0,
    itemCount: 0,
    evictionPolicy: 'orphan-gc-lru',
  },
  'chat-media-cache': {
    id: 'chat-media-cache',
    title: 'Chats 会话富媒体缓存',
    description: '日常聊天浏览产生的头像、气泡原图、贴纸与语音片段',
    storageLocation: 'CacheStorage / OPFS /chat-media-cache/*',
    defaultLimitMB: 512,
    minLimitMB: 128,
    maxLimitMB: 2048,
    configuredLimitMB: 512,
    usedBytes: 0,
    itemCount: 0,
    evictionPolicy: 'ttl-lru',
  },
  'search-stream-buffer': {
    id: 'search-stream-buffer',
    title: '聚合搜索与流媒体预读池',
    description: '聚合搜索缩略图与 noforwards 视频边播边存 512KiB 分片缓冲',
    storageLocation: 'OPFS /search-stream-buffer/*',
    defaultLimitMB: 384,
    minLimitMB: 128,
    maxLimitMB: 1024,
    configuredLimitMB: 384,
    usedBytes: 0,
    itemCount: 0,
    evictionPolicy: 'ring-buffer-fifo',
  },
  'explore-offline-blobs': {
    id: 'explore-offline-blobs',
    title: 'Explore 离线媒体资产库',
    description: '用户主动缓存至本地的完整视频/文档，支持钉选（Pin）防驱逐保护',
    storageLocation: 'OPFS /explore-offline-blobs/*',
    defaultLimitMB: 2048,
    minLimitMB: 512,
    maxLimitMB: 10240,
    configuredLimitMB: 2048,
    usedBytes: 0,
    itemCount: 0,
    evictionPolicy: 'lru-unpinned',
  },
};

class StorageQuotaEvictor {
  private configuredLimitsMB: Record<StorageSubDomainId, number> = {
    'core-metadata': 50,
    'explore-thumbs': 256,
    'chat-media-cache': 512,
    'search-stream-buffer': 384,
    'explore-offline-blobs': 2048,
  };
  private isPersistedStorage = false;

  constructor() {
    this.loadSavedLimits();
    void this.ensurePersistentStoragePermission();
  }

  private loadSavedLimits(): void {
    try {
      const raw = localStorage.getItem(QUOTA_CONFIG_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<Record<StorageSubDomainId, number>>;
      for (const key of Object.keys(DEFAULT_SUBDOMAIN_QUOTAS) as StorageSubDomainId[]) {
        const val = parsed[key];
        const def = DEFAULT_SUBDOMAIN_QUOTAS[key];
        if (typeof val === 'number' && val >= def.minLimitMB && val <= def.maxLimitMB) {
          this.configuredLimitsMB[key] = val;
        }
      }
    } catch {
      // ignore
    }
  }

  public setSubDomainLimitMB(subDomain: StorageSubDomainId, limitMB: number): void {
    const def = DEFAULT_SUBDOMAIN_QUOTAS[subDomain];
    const clamped = Math.max(def.minLimitMB, Math.min(def.maxLimitMB, Math.round(limitMB)));
    this.configuredLimitsMB[subDomain] = clamped;
    try {
      localStorage.setItem(QUOTA_CONFIG_STORAGE_KEY, JSON.stringify(this.configuredLimitsMB));
    } catch {
      // ignore
    }
  }

  public async ensurePersistentStoragePermission(): Promise<boolean> {
    try {
      if (typeof navigator !== 'undefined' && navigator.storage?.persist) {
        const persisted = await navigator.storage.persisted();
        if (persisted) {
          this.isPersistedStorage = true;
          return true;
        }
        this.isPersistedStorage = await navigator.storage.persist();
        return this.isPersistedStorage;
      }
    } catch {
      // ignore
    }
    return false;
  }

  public getIsPersistedStorage(): boolean {
    return this.isPersistedStorage;
  }

  /**
   * 汇总五大子域的实时使用量与配额快照
   */
  public computeSubDomainQuotas(): StorageSubDomainQuota[] {
    const entries = opfsExploreStorage.getAllFileEntries();
    const usageMap: Record<StorageSubDomainId, { bytes: number; count: number }> = {
      'core-metadata': { bytes: 16 * 1024, count: 1 },
      'explore-thumbs': { bytes: 0, count: 0 },
      'chat-media-cache': { bytes: 0, count: 0 },
      'search-stream-buffer': { bytes: 0, count: 0 },
      'explore-offline-blobs': { bytes: 0, count: 0 },
    };

    for (const entry of entries) {
      const bucket = usageMap[entry.subDomain];
      if (bucket) {
        bucket.bytes += entry.sizeBytes;
        bucket.count += 1;
      }
    }

    return (Object.keys(DEFAULT_SUBDOMAIN_QUOTAS) as StorageSubDomainId[]).map((id) => {
      const base = DEFAULT_SUBDOMAIN_QUOTAS[id];
      const stat = usageMap[id];
      return {
        ...base,
        configuredLimitMB: this.configuredLimitsMB[id] ?? base.defaultLimitMB,
        usedBytes: stat.bytes,
        itemCount: stat.count,
      };
    });
  }

  /**
   * 执行孤儿缩略图回收 + 五子域超限自适应淘汰
   * @param activeTileIds 当前在 Explore 磁贴树中存活的所有磁贴 ID 集合
   */
  public async runMaintenanceAndEviction(activeTileIds: Set<string>): Promise<{
    freedBytes: number;
    removedCount: number;
  }> {
    let freedBytes = 0;
    let removedCount = 0;
    const now = Date.now();
    const allEntries = opfsExploreStorage.getAllFileEntries();

    // 1. 孤儿缩略图引用计数 GC：磁贴已被物理删除但缩略图残留
    for (const entry of allEntries) {
      if (
        entry.subDomain === 'explore-thumbs' &&
        entry.tileId &&
        !activeTileIds.has(entry.tileId)
      ) {
        await opfsExploreStorage.deleteFileByPath(entry.path);
        freedBytes += entry.sizeBytes;
        removedCount += 1;
      } else if (
        entry.subDomain === 'chat-media-cache' &&
        now - entry.lastAccessedAt > CHAT_CACHE_TTL_MS
      ) {
        await opfsExploreStorage.deleteFileByPath(entry.path);
        freedBytes += entry.sizeBytes;
        removedCount += 1;
      }
    }

    // 2. 检查各子域是否超过 configuredLimitMB，若超限则执行对应策略降水位至 80%
    const remainingEntries = opfsExploreStorage.getAllFileEntries();
    const bySubDomain = new Map<StorageSubDomainId, typeof remainingEntries>();

    for (const entry of remainingEntries) {
      const list = bySubDomain.get(entry.subDomain) ?? [];
      list.push(entry);
      bySubDomain.set(entry.subDomain, list);
    }

    for (const [subDomain, list] of bySubDomain.entries()) {
      if (subDomain === 'core-metadata') continue;

      const limitBytes = (this.configuredLimitsMB[subDomain] ?? 256) * 1024 * 1024;
      let totalBytes = list.reduce((acc, item) => acc + item.sizeBytes, 0);
      if (totalBytes <= limitBytes) continue;

      const targetWaterlineBytes = Math.floor(limitBytes * 0.8);
      // 过滤掉被钉选（pinned）的文件
      const evictable = list.filter((item) => !item.pinned);

      if (subDomain === 'search-stream-buffer') {
        // FIFO：按创建时间从早到晚淘汰
        evictable.sort((a, b) => a.createdAt - b.createdAt);
      } else {
        // LRU：按最近访问时间从早到晚淘汰
        evictable.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
      }

      for (const victim of evictable) {
        if (totalBytes <= targetWaterlineBytes) break;
        await opfsExploreStorage.deleteFileByPath(victim.path);
        totalBytes -= victim.sizeBytes;
        freedBytes += victim.sizeBytes;
        removedCount += 1;
      }
    }

    return { freedBytes, removedCount };
  }

  /**
   * 手动清空指定子域的缓存（保留 core-metadata 与 pinned 离线资产）
   */
  public async clearSubDomainCache(
    subDomain: Exclude<StorageSubDomainId, 'core-metadata'>
  ): Promise<number> {
    let freedBytes = 0;
    const entries = opfsExploreStorage.getAllFileEntries();
    for (const entry of entries) {
      if (entry.subDomain === subDomain && !entry.pinned) {
        await opfsExploreStorage.deleteFileByPath(entry.path);
        freedBytes += entry.sizeBytes;
      }
    }
    return freedBytes;
  }
}

export const storageQuotaEvictor = new StorageQuotaEvictor();
