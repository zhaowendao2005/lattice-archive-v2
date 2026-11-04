import type { AggregateSearchResultItem, SearchPreFilterCategory, StreamingSearchQuery } from './searchContracts';
import type { TgMessageDto, TgPeerRef } from '../chatProtocol';
function formatBytesHuman(bytes: number | undefined): string {
  if (bytes === undefined) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function mapTgMessageToSearchResult(
  msg: TgMessageDto,
  sessionTitle: string,
  sessionKind: 'joined' | 'credential_only',
  options?: {
    accountId?: string;
    peerRef?: TgPeerRef;
  },
): AggregateSearchResultItem {
  let category: SearchPreFilterCategory = 'other';
  let categoryLabel = '消息';
  let extension = 'msg';
  let fileType: AggregateSearchResultItem['fileType'] = 'generic';
  let badgeMeta = `#${msg.id}`;
  let sizeBytes: number | undefined;
  let durationSeconds: number | undefined;
  let width: number | undefined;
  let height: number | undefined;
  let thumbUrl = '';

  if (msg.media?.photo) {
    category = 'image';
    categoryLabel = '图片';
    extension = 'jpg';
    fileType = 'image';
    width = msg.media.photo.full.width;
    height = msg.media.photo.full.height;
    sizeBytes = msg.media.photo.full.bytes;
    badgeMeta = width && height ? `${width}×${height}` : 'PHOTO';
    if (msg.media.photo.thumb) thumbUrl = msg.media.photo.thumb;
  } else if (msg.media?.video) {
    const vid = msg.media.video;
    category = 'video';
    categoryLabel = '视频';
    fileType = 'video';
    sizeBytes = vid.size;
    durationSeconds = vid.duration;
    width = vid.width;
    height = vid.height;
    if (vid.cover?.thumb) thumbUrl = vid.cover.thumb;
    else if (vid.thumb) thumbUrl = vid.thumb;
    const extMatch = vid.fileName ? /\.([a-zA-Z0-9]{1,8})$/.exec(vid.fileName) : null;
    extension = extMatch ? extMatch[1]!.toLowerCase() : (vid.mimeType.split('/')[1] || 'mp4');
    const mins = Math.floor((vid.duration ?? 0) / 60);
    const secs = Math.floor((vid.duration ?? 0) % 60);
    badgeMeta = vid.duration ? `${mins}:${String(secs).padStart(2, '0')}` : 'VIDEO';
  } else if (msg.media?.file) {
    const doc = msg.media.file;
    sizeBytes = doc.size;
    if (doc.thumb) thumbUrl = doc.thumb;
    const extMatch = doc.fileName ? /\.([a-zA-Z0-9]{1,8})$/.exec(doc.fileName) : null;
    extension = extMatch ? extMatch[1]!.toLowerCase() : (doc.mimeType.split('/')[1] || 'bin');
    if (doc.mimeType.startsWith('text/') || /pdf|md|txt|json|csv|doc/i.test(extension)) {
      category = 'text';
      categoryLabel = '文档';
      fileType = extension === 'pdf' ? 'pdf' : 'doc';
      badgeMeta = extension.toUpperCase();
    } else {
      category = 'other';
      categoryLabel = '归档包';
      fileType = 'archive';
      badgeMeta = extension.toUpperCase();
    }
  } else if (msg.webPage?.photo?.thumb) {
    thumbUrl = msg.webPage.photo.thumb;
  }

  const title =
    msg.media?.video?.fileName ||
    msg.media?.file?.fileName ||
    msg.text.split(/\r?\n/)[0]?.slice(0, 64) ||
    `${sessionTitle} · 消息 #${msg.id}`;

  return {
    id: `tg-${msg.peerKey}-${msg.id}`,
    title,
    snippet: msg.text || `${sessionTitle} 中的${categoryLabel}资产 (#${msg.id})`,
    category,
    categoryLabel,
    fileType,
    extension,
    fileSize: formatBytesHuman(sizeBytes),
    sizeBytes,
    durationSeconds,
    width,
    height,
    dateSeconds: msg.date,
    updatedAt: new Date(msg.date * 1000).toLocaleDateString('zh-CN'),
    thumbnailUrl: thumbUrl,
    thumbTier0Url: thumbUrl || undefined,
    badgeMeta,
    sessionId: msg.peerKey,
    sessionTitle,
    sessionKind,
    originAccountId: options?.accountId,
    peerRef: options?.peerRef,
    groupedId: msg.groupedId,
    noforwards: msg.noforwards,
    msgId: msg.id,
    photoInfo: msg.media?.photo,
    videoInfo: msg.media?.video,
    fileInfo: msg.media?.file,
  };
}


/** Empty number inputs mean unbounded. Vue number inputs may produce number | string. */
export function parseSearchSize(raw: string | number): number | undefined {
  if (String(raw).trim() === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value * 1024 * 1024 > Number.MAX_SAFE_INTEGER) throw new Error('文件大小必须是有效的非负数字');
  return Math.round(value * 1024 * 1024);
}
/** Telegram 单次 Search 能表达的服务端过滤器。 */
export type SearchServerFilter = 'all' | 'video' | 'photo' | 'document';

/**
 * 把搜索前的类型选择映射为服务端 filter 列表。
 * 每种可映射类型独立成一个请求单元（按类型拆请求），从而缩小每次 Telegram 返回的候选量；
 * 只要出现无法映射的类别（other / session）或没有选择，就退回一次 `all` 请求。
 */
export function candidateFilters(categories: SearchPreFilterCategory[]): SearchServerFilter[] {
  if (!categories.length) return ['all'];
  const mapped = new Set<SearchServerFilter>();
  for (const category of categories) {
    if (category === 'video') mapped.add('video');
    else if (category === 'image') mapped.add('photo');
    else if (category === 'text') mapped.add('document');
    else return ['all'];
  }
  return mapped.size ? Array.from(mapped) : ['all'];
}
export function searchQueryKey(query: StreamingSearchQuery, filter: SearchServerFilter): string {
  return JSON.stringify({ version: 2, keyword: query.keyword.trim(), minDate: query.minDate ?? 0, maxDate: query.maxDate ?? 0, filter });
}
/** The server has already matched the keyword; never replace its semantics with substring matching. */
export function matchesSearchFilters(item: AggregateSearchResultItem, query: StreamingSearchQuery): boolean {
  return (!query.minDate || (item.dateSeconds ?? 0) >= query.minDate)
    && (!query.maxDate || (item.dateSeconds ?? 0) <= query.maxDate)
    && (!query.preCategories.length || query.preCategories.includes(item.category))
    && (!query.preExtensions?.length || query.preExtensions.includes(item.extension.toLowerCase()));
}
/** 结果行高 = HEAD 卡片高度（约 85px）+ 原 space-y-2 间距（8px）。 */
export const SEARCH_ROW_HEIGHT = 93;
/** 会话范围行高 = HEAD 会话卡片高度（约 82px）+ 8px 间距；凭据且带过期时间的卡片更高。 */
export const SCOPE_ROW_HEIGHT = 90;
export const SCOPE_ROW_TALL_HEIGHT = 109;
export const SEARCH_OVERSCAN = 5;
export function searchWindow(count: number, scrollTop: number, height: number) {
  const visible = Math.max(1, Math.ceil(height / SEARCH_ROW_HEIGHT));
  const first = Math.min(Math.max(0, count - visible), Math.max(0, Math.floor(scrollTop / SEARCH_ROW_HEIGHT)));
  return { start: Math.max(0, first - SEARCH_OVERSCAN), end: Math.min(count, first + visible + SEARCH_OVERSCAN) };
}
export function scopeRowHeight(session: { kind: string; expiresLabel?: string }): number {
  return session.kind === 'credential_only' && session.expiresLabel ? SCOPE_ROW_TALL_HEIGHT : SCOPE_ROW_HEIGHT;
}
/** 变高行的前缀偏移窗口：offsets[i] 为第 i 行顶部位置，长度为 count + 1。 */
export function variableWindow(offsets: readonly number[], scrollTop: number, height: number) {
  const count = offsets.length - 1;
  const total = offsets[count] ?? 0;
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= scrollTop) lo = mid;
    else hi = mid - 1;
  }
  const first = Math.min(lo, Math.max(0, count - 1));
  const bottom = scrollTop + height;
  let last = first;
  while (last < count && offsets[last] < bottom) last++;
  const start = Math.max(0, first - SEARCH_OVERSCAN);
  const end = Math.min(count, last + SEARCH_OVERSCAN);
  return { start, end, paddingTop: offsets[start], paddingBottom: total - offsets[end] };
}

export interface SearchPostFilters {
  categories: SearchPreFilterCategory[];
  keyword: string;
  resolution: 'all' | '720p' | '1080p' | '4k';
  duration: 'all' | 'short' | 'medium' | 'long';
  /** 精确资源大小边界（字节），只作用于视频与图片；其他类型不受影响。 */
  minSizeBytes?: number;
  maxSizeBytes?: number;
  excludeProtected: boolean;
  deduplicate: boolean;
}
/** Append-only result projection. Re-evaluate history only when filters/source change. */
export class SearchResultProjection {
  private source?: AggregateSearchResultItem[];
  private key = '';
  private processed = 0;
  private items: AggregateSearchResultItem[] = [];
  private documents = new Set<string>();
  update(source: AggregateSearchResultItem[], filters: SearchPostFilters): AggregateSearchResultItem[] {
    const key = JSON.stringify(filters);
    if (this.source !== source || key !== this.key || source.length < this.processed) {
      this.source = source; this.key = key; this.processed = 0; this.items = []; this.documents.clear();
    }
    const keyword = filters.keyword.trim().toLowerCase();
    for (; this.processed < source.length; this.processed++) {
      const item = source[this.processed]!;
      if (filters.categories.length && !filters.categories.includes(item.category)) continue;
      if (keyword && !`${item.title}\n${item.snippet}\n${item.sessionTitle}`.toLowerCase().includes(keyword)) continue;
      if (filters.excludeProtected && item.noforwards) continue;
      const requiredHeight = filters.resolution === '4k' ? 2160 : filters.resolution === '1080p' ? 1080 : filters.resolution === '720p' ? 720 : 0;
      if ((item.height ?? 0) < requiredHeight) continue;
      const seconds = item.durationSeconds ?? 0;
      if (filters.duration === 'short' && !(seconds > 0 && seconds < 60)) continue;
      if (filters.duration === 'medium' && !(seconds >= 60 && seconds <= 900)) continue;
      if (filters.duration === 'long' && seconds <= 900) continue;
      if (filters.minSizeBytes !== undefined || filters.maxSizeBytes !== undefined) {
        // 精确体积只在有可靠 sizeBytes 的视频/图片上生效；其他类型不受该条件约束。
        if (item.category === 'video' || item.category === 'image') {
          if (item.sizeBytes === undefined) continue;
          if (filters.minSizeBytes !== undefined && item.sizeBytes < filters.minSizeBytes) continue;
          if (filters.maxSizeBytes !== undefined && item.sizeBytes > filters.maxSizeBytes) continue;
        }
      }      if (filters.deduplicate) {
        const documentId = item.videoInfo?.id ?? item.fileInfo?.id;
        const id = documentId ? `document:${documentId}` : item.photoInfo?.id ? `photo:${item.photoInfo.id}` : undefined;
        if (id && this.documents.has(id)) continue;
        if (id) this.documents.add(id);
      }
      this.items.push(item);
    }
    // A new shallow snapshot notifies Vue while keeping the historical predicate work incremental.
    return this.items.slice();
  }
}
