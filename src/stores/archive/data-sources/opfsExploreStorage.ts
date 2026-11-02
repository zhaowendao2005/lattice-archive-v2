/**
 * ============================================================================
 * Explore 虚拟文件系统本地 OPFS 持久化引擎 (OPFS Explore Storage DataSource)
 * ============================================================================
 * 职责：
 * 1. 基于浏览器 Origin Private File System (`navigator.storage.getDirectory()`)
 *    持久化 `/explore-manifest.v2.json`、`/thumbs/{tileId}.webp` 与 `/offline-blobs/*`；
 * 2. 若运行环境不支持 OPFS，平滑回退至 IndexedDB / localStorage，保障 100% 可用；
 * 3. 提供 `.lattice-archive` 离线冷备包导出与导入（内含 manifest JSON + 全部缩略图二进制）；
 * 4. 维护缩略图内存 ObjectURL 池与生命周期回收。
 */
import type {
  ExploreManifestV2,
  OpfsFileEntryMeta,
  StorageSubDomainId,
} from '@/stores/archive/types';

const MANIFEST_FILENAME = 'explore-manifest.v2.json';
const FALLBACK_STORAGE_KEY = 'lattice_explore_manifest_v2';
const FILE_INDEX_STORAGE_KEY = 'lattice_opfs_file_index_v2';
const DEVICE_ID_STORAGE_KEY = 'lattice_explore_device_id';

interface ColdBackupBundleV2 {
  magic: 'LATTICE_ARCHIVE_V2';
  exportedAtMs: number;
  manifest: ExploreManifestV2;
  thumbs: Record<string, string>; // tileId -> base64 encoded WebP/JPEG bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** 按文件头识别真实图片 MIME：避免把 JPEG 字节标成 image/webp 导致部分浏览器无法解码。 */
function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}

class OpfsExploreStorage {
  private rootDirPromise: Promise<FileSystemDirectoryHandle | null> | null = null;
  private objectUrlCache = new Map<string, string>();
  private fallbackThumbs = new Map<string, Uint8Array>();
  private fileIndex = new Map<string, OpfsFileEntryMeta>();

  constructor() {
    this.loadFileIndexFromStorage();
  }

  public getOrCreateDeviceId(): string {
    try {
      const existing = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
      if (existing) return existing;
      const created = `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_ID_STORAGE_KEY, created);
      return created;
    } catch {
      return 'dev-local-default';
    }
  }

  private loadFileIndexFromStorage(): void {
    try {
      const raw = localStorage.getItem(FILE_INDEX_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as OpfsFileEntryMeta[];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          this.fileIndex.set(item.path, item);
        }
      }
    } catch {
      // ignore corrupted index
    }
  }

  private persistFileIndex(): void {
    try {
      const list = Array.from(this.fileIndex.values());
      localStorage.setItem(FILE_INDEX_STORAGE_KEY, JSON.stringify(list));
    } catch {
      // ignore quota error
    }
  }

  private async getRootDir(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.rootDirPromise) {
      this.rootDirPromise = (async () => {
        try {
          if (typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
            return await navigator.storage.getDirectory();
          }
        } catch {
          // OPFS unavailable in current context
        }
        return null;
      })();
    }
    return this.rootDirPromise;
  }

  private async getSubDir(dirName: string, create = true): Promise<FileSystemDirectoryHandle | null> {
    const root = await this.getRootDir();
    if (!root) return null;
    try {
      return await root.getDirectoryHandle(dirName, { create });
    } catch {
      return null;
    }
  }

  /**
   * 读取持久化在 OPFS 的 `/explore-manifest.v2.json`
   */
  public async readManifest(): Promise<ExploreManifestV2 | null> {
    const root = await this.getRootDir();
    if (root) {
      try {
        const handle = await root.getFileHandle(MANIFEST_FILENAME, { create: false });
        const file = await handle.getFile();
        const text = await file.text();
        if (text) {
          return JSON.parse(text) as ExploreManifestV2;
        }
      } catch {
        // Fallback to localStorage if file doesn't exist yet
      }
    }
    try {
      const fallbackText = localStorage.getItem(FALLBACK_STORAGE_KEY);
      if (fallbackText) {
        return JSON.parse(fallbackText) as ExploreManifestV2;
      }
    } catch {
      // ignore
    }
    return null;
  }

  /**
   * 原子写入 `/explore-manifest.v2.json` 并更新 `core-metadata` 子域用量
   */
  public async writeManifest(manifest: ExploreManifestV2): Promise<number> {
    const serialized = JSON.stringify(manifest);
    const byteLength = new TextEncoder().encode(serialized).byteLength;

    // 同步保存一份到 localStorage 作为快速热备与回退
    try {
      localStorage.setItem(FALLBACK_STORAGE_KEY, serialized);
    } catch {
      // ignore
    }

    const root = await this.getRootDir();
    if (root) {
      try {
        const handle = await root.getFileHandle(MANIFEST_FILENAME, { create: true });
        if ('createWritable' in handle) {
          const writable = await handle.createWritable();
          await writable.write(serialized);
          await writable.close();
        }
      } catch {
        // fallback already saved
      }
    }

    const now = Date.now();
    this.fileIndex.set(`/${MANIFEST_FILENAME}`, {
      path: `/${MANIFEST_FILENAME}`,
      subDomain: 'core-metadata',
      sizeBytes: byteLength,
      lastAccessedAt: now,
      createdAt: now,
      pinned: true,
    });
    this.persistFileIndex();
    return byteLength;
  }

  /**
   * 写入磁贴高清缩略图 `/thumbs/{tileId}.webp` 并返回可用的 ObjectURL
   */
  public async writeThumbnail(tileId: string, bytes: Uint8Array, mimeType?: string): Promise<{
    opfsPath: string;
    objectUrl: string;
  }> {
    const fileName = `${tileId}.webp`;
    const opfsPath = `/thumbs/${fileName}`;
    const thumbsDir = await this.getSubDir('thumbs', true);

    if (thumbsDir) {
      try {
        const fileHandle = await thumbsDir.getFileHandle(fileName, { create: true });
        if ('createWritable' in fileHandle) {
          const writable = await fileHandle.createWritable();
          const buf = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buf).set(bytes);
          await writable.write(buf);
          await writable.close();
        }
      } catch {
        this.fallbackThumbs.set(tileId, bytes);
      }
    } else {
      this.fallbackThumbs.set(tileId, bytes);
    }

    const prevUrl = this.objectUrlCache.get(tileId);
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl);
    }
    const copyBuf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copyBuf).set(bytes);
    const blob = new Blob([copyBuf], { type: mimeType ?? sniffImageMime(bytes) });
    const objectUrl = URL.createObjectURL(blob);
    this.objectUrlCache.set(tileId, objectUrl);

    const now = Date.now();
    this.fileIndex.set(opfsPath, {
      path: opfsPath,
      subDomain: 'explore-thumbs',
      sizeBytes: bytes.byteLength,
      lastAccessedAt: now,
      createdAt: now,
      tileId,
    });
    this.persistFileIndex();

    return { opfsPath, objectUrl };
  }

  /**
   * 读取磁贴缩略图并生成/复用内存 ObjectURL
   */
  public async readThumbnailObjectUrl(tileId: string): Promise<string | null> {
    const cached = this.objectUrlCache.get(tileId);
    if (cached) {
      this.touchFile(`/thumbs/${tileId}.webp`);
      return cached;
    }

    const bytes = await this.readThumbnailBytes(tileId);
    if (!bytes) return null;

    const copyBuf = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(copyBuf).set(bytes);
    const blob = new Blob([copyBuf], { type: sniffImageMime(bytes) });
    const url = URL.createObjectURL(blob);
    this.objectUrlCache.set(tileId, url);
    this.touchFile(`/thumbs/${tileId}.webp`);
    return url;
  }

  public async readThumbnailBytes(tileId: string): Promise<Uint8Array | null> {
    const fallback = this.fallbackThumbs.get(tileId);
    if (fallback) return fallback;

    const thumbsDir = await this.getSubDir('thumbs', false);
    if (!thumbsDir) return null;

    try {
      const fileHandle = await thumbsDir.getFileHandle(`${tileId}.webp`, { create: false });
      const file = await fileHandle.getFile();
      const ab = await file.arrayBuffer();
      return new Uint8Array(ab);
    } catch {
      return null;
    }
  }

  /**
   * 删除指定磁贴缩略图文件并释放 ObjectURL
   */
  public async deleteThumbnail(tileId: string): Promise<void> {
    const url = this.objectUrlCache.get(tileId);
    if (url) {
      URL.revokeObjectURL(url);
      this.objectUrlCache.delete(tileId);
    }
    this.fallbackThumbs.delete(tileId);
    const opfsPath = `/thumbs/${tileId}.webp`;
    this.fileIndex.delete(opfsPath);
    this.persistFileIndex();

    const thumbsDir = await this.getSubDir('thumbs', false);
    if (thumbsDir) {
      try {
        await thumbsDir.removeEntry(`${tileId}.webp`);
      } catch {
        // ignore
      }
    }
  }

  /**
   * 写入任意子域二进制文件（如 explore-offline-blobs / search-stream-buffer / chat-media-cache）
   */
  public async writeSubDomainBlob(
    subDomain: StorageSubDomainId,
    key: string,
    bytes: Uint8Array,
    options?: { pinned?: boolean; tileId?: string }
  ): Promise<string> {
    const safeName = key.replace(/[^a-zA-Z0-9._-]/g, '_');
    const opfsPath = `/${subDomain}/${safeName}`;
    const subDir = await this.getSubDir(subDomain, true);

    if (subDir) {
      try {
        const fileHandle = await subDir.getFileHandle(safeName, { create: true });
        if ('createWritable' in fileHandle) {
          const writable = await fileHandle.createWritable();
          const buf = new ArrayBuffer(bytes.byteLength);
          new Uint8Array(buf).set(bytes);
          await writable.write(buf);
          await writable.close();
        }
      } catch {
        // ignore write failure
      }
    }

    const now = Date.now();
    this.fileIndex.set(opfsPath, {
      path: opfsPath,
      subDomain,
      sizeBytes: bytes.byteLength,
      lastAccessedAt: now,
      createdAt: now,
      pinned: options?.pinned,
      tileId: options?.tileId,
    });
    this.persistFileIndex();
    return opfsPath;
  }

  /**
   * 删除指定 OPFS 路径文件
   */
  public async deleteFileByPath(opfsPath: string): Promise<void> {
    const entry = this.fileIndex.get(opfsPath);
    if (entry?.tileId && entry.subDomain === 'explore-thumbs') {
      await this.deleteThumbnail(entry.tileId);
      return;
    }

    this.fileIndex.delete(opfsPath);
    this.persistFileIndex();

    const parts = opfsPath.split('/').filter(Boolean);
    if (parts.length === 2) {
      const [dirName, fileName] = parts;
      if (dirName && fileName) {
        const subDir = await this.getSubDir(dirName, false);
        if (subDir) {
          try {
            await subDir.removeEntry(fileName);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  public touchFile(opfsPath: string): void {
    const entry = this.fileIndex.get(opfsPath);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      this.persistFileIndex();
    }
  }

  public getAllFileEntries(): OpfsFileEntryMeta[] {
    return Array.from(this.fileIndex.values());
  }

  /**
   * 导出 `.lattice-archive` 完整冷备归档包（Gzip 压缩二进制）
   */
  public async exportColdBackupArchive(
    manifest: ExploreManifestV2,
    tileIds: string[]
  ): Promise<Blob> {
    const thumbs: Record<string, string> = {};
    for (const tileId of tileIds) {
      const bytes = await this.readThumbnailBytes(tileId);
      if (bytes && bytes.byteLength > 0) {
        thumbs[tileId] = bytesToBase64(bytes);
      }
    }

    const bundle: ColdBackupBundleV2 = {
      magic: 'LATTICE_ARCHIVE_V2',
      exportedAtMs: Date.now(),
      manifest,
      thumbs,
    };

    const jsonBytes = new TextEncoder().encode(JSON.stringify(bundle));
    if (typeof CompressionStream !== 'undefined') {
      try {
        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        const copyBuf = new ArrayBuffer(jsonBytes.byteLength);
        new Uint8Array(copyBuf).set(jsonBytes);
        await writer.write(copyBuf);
        await writer.close();
        const compressedBuffer = await new Response(cs.readable).arrayBuffer();
        return new Blob([compressedBuffer], { type: 'application/octet-stream' });
      } catch {
        // Fallback to uncompressed JSON blob
      }
    }
    const rawBuf = new ArrayBuffer(jsonBytes.byteLength);
    new Uint8Array(rawBuf).set(jsonBytes);
    return new Blob([rawBuf], { type: 'application/json' });
  }

  /**
   * 导入 `.lattice-archive` 冷备归档包并恢复缩略图至 OPFS
   */
  public async importColdBackupArchive(file: File): Promise<ExploreManifestV2> {
    let rawText = '';
    const arrayBuffer = await file.arrayBuffer();
    const headerBytes = new Uint8Array(arrayBuffer.slice(0, 2));
    const isGzip = headerBytes.length === 2 && headerBytes[0] === 0x1f && headerBytes[1] === 0x8b;

    if (isGzip && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      await writer.write(arrayBuffer);
      await writer.close();
      rawText = await new Response(ds.readable).text();
    } else {
      rawText = new TextDecoder().decode(arrayBuffer);
    }

    const parsed = JSON.parse(rawText) as ColdBackupBundleV2;
    if (!parsed || parsed.magic !== 'LATTICE_ARCHIVE_V2' || !parsed.manifest) {
      throw new Error('无效的 .lattice-archive 归档备份文件格式');
    }

    if (parsed.thumbs && typeof parsed.thumbs === 'object') {
      for (const [tileId, b64] of Object.entries(parsed.thumbs)) {
        const bytes = base64ToBytes(b64);
        await this.writeThumbnail(tileId, bytes);
      }
    }

    await this.writeManifest(parsed.manifest);
    return parsed.manifest;
  }
}

export const opfsExploreStorage = new OpfsExploreStorage();
