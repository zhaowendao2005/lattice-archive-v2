/**
 * ============================================================================
 * 聚合搜索数据源接线器 (Aggregate Search Data Source Singleton)
 * ============================================================================
 * 定位：归档与聚合搜索业务域唯一的全局单例连接器。
 * 职责：
 * 1. 三级混合检索管线（L0 本地磁贴与临时凭据索引 + L1 跨账号 MTProto messages.Search/SearchGlobal + 开发态 Mock 隔离）；
 * 2. 提供支持 `AbortSignal` 的逐会话持续检索异步生成器 (`streamFocusedSearch`)；
 * 3. 统一托管触底懒加载的 `IntersectionObserver` 句柄与拖拽悬停展开定时器，保证视图层零本地 `ref`。
 */
import { MOCK_SCOPE_SESSIONS, MOCK_SEARCH_RESULTS_POOL, SEARCH_CATEGORY_OPTIONS } from '../mocks/aggregateSearchMock';
import type {
  AggregateSearchResultItem,
  SearchCategoryOption,
  SearchPreFilterCategory,
  SearchScopeSessionDto,
  StreamingSearchChunk,
  StreamingSearchQuery,
} from '../types';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { coverSizeOf, videoPreviewOf } from '@/stores/chat/stores/chatModel';
import { telegramBusClient } from '@/stores/telegram/data-sources/telegramBusClient';
import { coverImageBus } from '@/stores/app/data-sources/coverImageBus';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import {
  classifyTelegramError,
  describeCoverUnavailable,
  type CoverUnavailableReason,
} from '@/worker/local/chat/telegramErrors';
import type { TgMediaFile, TgMessageDto, TgPeerKey, TgPeerRef } from '@/stores/chat/types';
import { useSessionManagerStore } from '../stores/sessionManagerStore';
import { aggregateSearchIndex, type SearchIndexCoverage } from './aggregateSearchIndex';

const isMockDev = Boolean(import.meta.env.DEV) && import.meta.env.VITE_ENABLE_MOCK_DATA === 'true';

function peerRefFromKey(key: TgPeerKey): TgPeerRef | undefined {
  const match = /^(user|chat|channel)-(\d+)$/.exec(key);
  return match ? { type: match[1] as TgPeerRef['type'], id: match[2] } : undefined;
}

function arrayBufferToDataUrl(bytes: ArrayBuffer, mimeType = 'image/jpeg'): string {
  const u8 = new Uint8Array(bytes);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < u8.length; i += chunkSize) {
    binary += String.fromCharCode(...u8.subarray(i, i + chunkSize));
  }
  return `data:${mimeType || 'image/jpeg'};base64,${btoa(binary)}`;
}

function formatBytesHuman(bytes: number): string {
  if (!bytes || bytes <= 0) return '12 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function mapTgMessageToSearchResult(
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
  let sizeBytes = 0;
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
    sizeBytes = msg.media.photo.full.bytes ?? 250_000;
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
    peerRef: options?.peerRef ?? peerRefFromKey(msg.peerKey),
    groupedId: msg.groupedId,
    noforwards: msg.noforwards,
    msgId: msg.id,
    photoInfo: msg.media?.photo,
    videoInfo: msg.media?.video,
    fileInfo: msg.media?.file,
  };
}

class AggregateSearchDataSource {
  private activeAbortController: AbortController | null = null;
  private treeExpandTimer: number | null = null;


  private logSearch(
    action: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    tags: Record<string, string | number | boolean | undefined>,
    message?: string,
    durMs?: number,
  ): void {
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.search',
      action,
      level,
      message,
      durMs,
      tags,
    });
  }

  private logCover(
    action: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    tags: Record<string, string | number | boolean | undefined>,
    message?: string,
    durMs?: number,
  ): void {
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.cover',
      action,
      level,
      message,
      durMs,
      tags,
    });
  }

  /** 封面请求被前端主动跳过时，写入与异常完全一致的分桶描述。 */
  private logCoverSkipped(
    item: AggregateSearchResultItem,
    reason: CoverUnavailableReason,
    extra?: Record<string, string | number | boolean | undefined>,
  ): void {
    const info = describeCoverUnavailable(reason);
    item.hdThumbError = info.code;
    this.logCover(
      'search_cover_skipped',
      'WARN',
      {
        itemId: item.id,
        category: item.category,
        sessionKind: item.sessionKind,
        bucket: info.bucket,
        code: info.code,
        retryable: info.retryable,
        ...extra,
      },
      info.description,
    );
  }

  /** 封面下载抛异常时记录统一分桶，避免上层只看到 null。 */
  private logCoverFailure(
    item: AggregateSearchResultItem,
    branch: string,
    error: unknown,
    startedAt: number,
    extra?: Record<string, string | number | boolean | undefined>,
  ): void {
    const info = classifyTelegramError(error);
    item.hdThumbError = info.code;
    this.logCover(
      'search_cover_error',
      'ERROR',
      {
        itemId: item.id,
        category: item.category,
        branch,
        bucket: info.bucket,
        code: info.code,
        retryable: info.retryable,
        ...extra,
      },
      info.description,
      Date.now() - startedAt,
    );
  }

  /** 获取搜索前筛选的 5 类文件类型元数据 */
  getCategoryOptions(): SearchCategoryOption[] {
    return SEARCH_CATEGORY_OPTIONS;
  }

  /** 获取右栏搜索范围控制的两类会话列表（实时已加入会话 + 临时凭据池会话） */
  getScopeSessions(): SearchScopeSessionDto[] {
    const chatStore = useChatStore();
    const sessionManagerStore = useSessionManagerStore();
    const realSessions: SearchScopeSessionDto[] = [];

    for (const dialog of Object.values(chatStore.dialogs)) {
      realSessions.push({
        id: dialog.key,
        title: dialog.title,
        initials: dialog.title.slice(0, 2).toUpperCase(),
        kind: 'joined',
        peerTypeLabel: dialog.kind === 'channel' ? '订阅频道' : dialog.kind === 'supergroup' ? '超级群组' : '对话',
        handleOrHash: dialog.username ? `@${dialog.username}` : dialog.key,
        itemCountLabel: dialog.participantsCount ? `${dialog.participantsCount} 成员` : '实时同步',
        accentClass: 'bg-sky-500/20 text-sky-300',
        peerRef: dialog.peer,
        username: dialog.username,
        credentialState: 'joined',
      });
    }

    for (const cred of sessionManagerStore.tempCredentials) {
      realSessions.push({
        id: cred.peerKey,
        title: cred.title,
        initials: cred.title.slice(0, 2).toUpperCase(),
        kind: 'credential_only',
        peerTypeLabel: cred.peerType === 'channel' ? '临时频道' : '临时群组',
        credentialBadge: cred.state === 'temp_auto_renew' ? '自动续期' : '临时凭据',
        handleOrHash: cred.username ? `@${cred.username}` : `+${cred.inviteHash ?? 'temp'}`,
        itemCountLabel: cred.participantsCount ? `${cred.participantsCount} 成员` : '凭据直连',
        accentClass: 'bg-amber-500/20 text-amber-300',
        accountId: cred.accountId,
        username: cred.username,
        inviteHash: cred.inviteHash,
        credentialState: cred.state,
        peekExpiresAt: cred.peekExpiresAt,
      });
    }

    if (realSessions.length > 0) return realSessions;
    return isMockDev ? MOCK_SCOPE_SESSIONS : [];
  }

  /** 中止当前在途的流式检索请求 */
  abortActiveStream(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
  }

  /** 创建新的流式检索取消信号 */
  createStreamSignal(): AbortSignal {
    this.abortActiveStream();
    this.activeAbortController = new AbortController();
    return this.activeAbortController.signal;
  }

  /**
   * 按会话持续扫描。每个会话只推进自己的游标；请求完成后立即把该会话重新放回队列，
   * 不等待其他会话，因此慢会话不会成为整批任务的栅栏。
   */
  async *streamFocusedSearch(
    query: StreamingSearchQuery,
    signal: AbortSignal,
  ): AsyncGenerator<StreamingSearchChunk, void, unknown> {
    type FocusedPeer = {
      key: TgPeerKey;
      peer: TgPeerRef;
      title: string;
      kind: 'joined' | 'credential_only';
      accountId: string;
    };
    const chatStore = useChatStore();
    const accountId = chatStore.accountId;
    if ((!accountId || !chatStore.isOnline) && isMockDev) {
      const keyword = query.keyword.trim().toLowerCase();
      const items = MOCK_SEARCH_RESULTS_POOL.filter((item) =>
        (!keyword || `${item.title}\n${item.snippet}`.toLowerCase().includes(keyword)) &&
        (query.preCategories.length === 0 || query.preCategories.includes(item.category)) &&
        (!query.preExtensions?.length || query.preExtensions.includes(item.extension.toLowerCase())) &&
        (query.minSizeBytes === undefined || (item.sizeBytes ?? 0) >= query.minSizeBytes) &&
        (query.maxSizeBytes === undefined || (item.sizeBytes ?? 0) <= query.maxSizeBytes),
      );
      for (const item of items) {
        if (signal.aborted) return;
        yield { items: [item], totalMatched: items.length, hasMore: true, isFinalChunkOfPage: true, sourceTier: 0 };
      }
      if (!signal.aborted) yield { items: [], totalMatched: items.length, hasMore: false, isFinalChunkOfPage: true, sourceTier: 0 };
      return;
    }
    if (!accountId || !chatStore.isOnline) return;
    const sessionManagerStore = useSessionManagerStore();

    const selected = query.scopeSessionIds.length > 0
      ? query.scopeSessionIds
      : [...Object.keys(chatStore.dialogs), ...sessionManagerStore.tempCredentials.map((item) => item.peerKey)];
    const peers: FocusedPeer[] = selected
      .map((key) => {
        const dialog = chatStore.dialogs[key];
        if (dialog) return { key: key as TgPeerKey, peer: dialog.peer, title: dialog.title, kind: 'joined' as const, accountId };
        const credential = sessionManagerStore.tempCredentials.find((item) => item.peerKey === key);
        if (!credential || credential.accountId !== accountId) return null;
        return {
          key: key as TgPeerKey,
          peer: { type: credential.peerType, id: credential.peerId, accessHash: credential.accessHash } as TgPeerRef,
          title: credential.title,
          kind: 'credential_only' as const,
          accountId: credential.accountId,
        };
      })
      .filter((item): item is FocusedPeer => item !== null);
    if (peers.length === 0) return;

    const queryKey = JSON.stringify({
      keyword: query.keyword.trim(),
      minDate: query.minDate ?? 0,
      maxDate: query.maxDate ?? 0,
      categories: [...query.preCategories].sort(),
    });
    const broadQueryKey = JSON.stringify({
      keyword: query.keyword.trim(),
      minDate: query.minDate ?? 0,
      maxDate: query.maxDate ?? 0,
      categories: [],
    });
    const indexSnapshot = await aggregateSearchIndex.read(accountId);
    const cursors = new Map<TgPeerKey, { offsetId?: number; done: boolean; pages: number; checked: number; matched: number }>();
    for (const item of peers) {
      const exactCoverage = aggregateSearchIndex.findCoverage(indexSnapshot, accountId, item.key, queryKey);
      const broadCoverage = query.preCategories.length > 0
        ? aggregateSearchIndex.findCoverage(indexSnapshot, accountId, item.key, broadQueryKey)
        : undefined;
      const coverage = exactCoverage ?? (broadCoverage?.complete ? broadCoverage : undefined);
      cursors.set(item.key, {
        offsetId: coverage?.nextOffsetId,
        done: coverage?.complete ?? false,
        pages: 0,
        checked: 0,
        matched: 0,
      });
    }

    for (const item of peers) {
      const cursor = cursors.get(item.key)!;
      yield {
        items: [],
        totalMatched: 0,
        hasMore: true,
        isFinalChunkOfPage: true,
        sourceTier: 0,
        peerProgress: {
          accountId,
          peerKey: item.key,
          status: cursor.done ? 'completed' : 'queued',
          pages: cursor.pages,
          checked: cursor.checked,
          matched: cursor.matched,
        },
      };
    }

    const matchesLocalFilters = (item: AggregateSearchResultItem) =>
      peers.some((peer) => peer.key === item.sessionId) &&
      (!query.minDate || (item.dateSeconds ?? 0) >= query.minDate) &&
      (!query.maxDate || (item.dateSeconds ?? 0) <= query.maxDate) &&
      (!query.keyword.trim() || `${item.title}\n${item.snippet}`.toLowerCase().includes(query.keyword.trim().toLowerCase())) &&
      (query.preCategories.length === 0 || query.preCategories.includes(item.category)) &&
      (query.preExtensions?.length === 0 || !query.preExtensions || query.preExtensions.includes(item.extension.toLowerCase())) &&
      (query.minSizeBytes === undefined || (item.sizeBytes !== undefined && item.sizeBytes >= query.minSizeBytes)) &&
      (query.maxSizeBytes === undefined || (item.sizeBytes !== undefined && item.sizeBytes <= query.maxSizeBytes));
    const cached = indexSnapshot.records.filter(matchesLocalFilters);
    let cachedTotal = 0;
    const emittedIds = new Set<string>();
    for (const item of cached) {
      if (signal.aborted) return;
      emittedIds.add(item.id);
      cachedTotal += 1;
      yield { items: [item], totalMatched: cachedTotal, hasMore: true, isFinalChunkOfPage: true, sourceTier: 0 };
    }

    const pending = new Map<TgPeerKey, Promise<{ key: TgPeerKey; items: AggregateSearchResultItem[]; next?: { offsetId?: number; done: boolean }; total: number; error?: unknown }>>();
    const schedule = (item: FocusedPeer) => {
      const cursor = cursors.get(item.key)!;
      pending.set(item.key, (async () => {
        try {
        const response = await telegramBusClient.search.searchMessages(accountId, {
          peer: item.peer,
          query: query.keyword,
          filterType: query.preCategories.length === 1
            ? query.preCategories[0] === 'video' ? 'video'
              : query.preCategories[0] === 'image' ? 'photo'
                : query.preCategories[0] === 'text' ? 'document' : 'all'
            : 'all',
          minDate: query.minDate,
          maxDate: query.maxDate,
          offsetId: cursor.offsetId,
          limit: query.pageSize,
        }, { signal, source: 'archive.focused-search' });
        const items = response.messages.map((message) => mapTgMessageToSearchResult(
          message,
          item.title,
          item.kind,
          { accountId: item.accountId, peerRef: item.peer },
        ));
        const last = response.messages[response.messages.length - 1];
        return {
          key: item.key,
          items,
          total: response.totalCount ?? items.length,
          next: { offsetId: response.nextOffsetId ?? last?.id, done: !response.hasMore || response.messages.length === 0 },
        };
        } catch (error) {
          return { key: item.key, items: [], total: 0, error };
        }
      })());
    };

    for (const item of peers) {
      if (!cursors.get(item.key)?.done) schedule(item);
    }
    let totalMatched = cachedTotal;
    while (pending.size > 0 && !signal.aborted) {
      const result = await Promise.race(pending.values());
      pending.delete(result.key);
      const cursor = cursors.get(result.key)!;
      cursor.pages += 1;
      if (result.error) {
        yield {
          items: [],
          totalMatched,
          hasMore: true,
          isFinalChunkOfPage: true,
          sourceTier: 2,
          peerProgress: { accountId, peerKey: result.key, status: 'error', pages: cursor.pages, checked: 0, matched: 0, errorCode: 'SEARCH_PAGE_FAILED' },
        };
        this.logSearch('focused_peer_error', 'WARN', { peerKey: result.key }, '单会话搜索失败，其他会话继续');
        continue;
      }
      cursor.offsetId = result.next?.offsetId;
      cursor.done = result.next?.done ?? true;
      const visibleItems = result.items.filter(matchesLocalFilters);
      cursor.checked += result.items.length;
      const freshVisibleItems = visibleItems.filter((item) => !emittedIds.has(item.id));
      for (const item of freshVisibleItems) emittedIds.add(item.id);
      cursor.matched += freshVisibleItems.length;
      totalMatched += freshVisibleItems.length;

      const coverage: SearchIndexCoverage = {
          accountId,
          peerKey: result.key,
          queryKey,
          minDate: query.minDate,
          maxDate: query.maxDate,
          oldestDate: result.items[result.items.length - 1]?.dateSeconds,
          oldestMessageId: result.items[result.items.length - 1]?.msgId,
          nextOffsetId: result.next?.offsetId,
          complete: cursor.done,
          updatedAt: Date.now(),
      };
      try {
        await aggregateSearchIndex.commit(accountId, result.items, [coverage]);
      } catch {
        this.logSearch('focused_index_write_failed', 'WARN', { peerKey: result.key }, '搜索索引写入失败，本次结果仍继续返回');
      }
      yield {
        items: [],
        totalMatched,
        hasMore: true,
        isFinalChunkOfPage: true,
        sourceTier: 2,
        peerProgress: { accountId, peerKey: result.key, status: cursor.done ? 'completed' : 'searching', pages: cursor.pages, checked: cursor.checked, matched: cursor.matched },
      };
      if (freshVisibleItems.length > 0) {
        for (const item of freshVisibleItems) {
          if (signal.aborted) return;
          yield { items: [item], totalMatched, hasMore: true, isFinalChunkOfPage: true, sourceTier: 2 };
        }
      }

      if (!cursor.done) {
        const peer = peers.find((item) => item.key === result.key)!;
        schedule(peer);
      }
    }
    if (!signal.aborted) {
      yield { items: [], totalMatched, hasMore: false, isFinalChunkOfPage: true, sourceTier: 2 };
    }
  }

  /**
   * 跨栏拖拽悬停在收起的树节点上时，延迟 420ms 自动展开该节点
   */
  scheduleTreeHoverExpand(callback: () => void, delayMs = 420): void {
    this.clearTreeHoverExpand();
    this.treeExpandTimer = window.setTimeout(() => {
      this.treeExpandTimer = null;
      callback();
    }, delayMs);
  }

  clearTreeHoverExpand(): void {
    if (this.treeExpandTimer !== null) {
      window.clearTimeout(this.treeExpandTimer);
      this.treeExpandTimer = null;
    }
  }

  /**
   * 按需加载指定搜索结果条目的高清缩略图（支持图片、视频封面/缩略图、文档缩略图与会话头像，接入 coverImageBus 总线调度）
   */
  async fetchHighResThumbnailDataUrl(item: AggregateSearchResultItem): Promise<string | null> {
    const startedAt = Date.now();
    return coverImageBus.request<string | null>({
      key: `search-hd-${item.id}`,
      lane: 'search',
      priority: 30,
      fetch: async () => {
        const chatStore = useChatStore();
        const accountId = item.originAccountId || chatStore.accountId;
        if (!accountId) {
          this.logCoverSkipped(item, 'NO_ACCOUNT');
          return null;
        }
        if (!chatStore.isOnline) {
          this.logCoverSkipped(item, 'OFFLINE', { accountId });
          return null;
        }

        const peerKey = (item.sessionId || (item.peerRef ? `${item.peerRef.type}-${item.peerRef.id}` : '')) as TgPeerKey;
        const dialog = peerKey ? chatStore.dialogs[peerKey] : undefined;
        const peer = item.peerRef ?? dialog?.peer ?? (peerKey ? peerRefFromKey(peerKey) : undefined);
        if (!peer) {
          this.logCoverSkipped(item, 'NO_PEER', { peerKey, accountId });
          return null;
        }

        const baseTags = {
          itemId: item.id,
          category: item.category,
          accountId,
          peerKey,
          msgId: item.msgId ?? 0,
          hasThumbTier0: Boolean(item.thumbnailUrl),
        };

        if (item.category === 'session') {
          if (!dialog?.avatar) {
            this.logCoverSkipped(item, 'NO_THUMB_SOURCE', { ...baseTags, branch: 'avatar' });
            return null;
          }
          try {
            const media = await telegramBusClient.cover.getAvatar(
              accountId,
              dialog.peer,
              dialog.avatar.photoId,
              dialog.avatar.dcId,
            );
            if (!media?.bytes || media.bytes.byteLength === 0) {
              this.logCoverSkipped(item, 'EMPTY_BYTES', { ...baseTags, branch: 'avatar' });
              return null;
            }
            this.logCover(
              'search_cover_ok',
              'INFO',
              { ...baseTags, branch: 'avatar', bytes: media.bytes.byteLength, mime: media.mimeType },
              '会话头像加载成功',
              Date.now() - startedAt,
            );
            item.hdThumbError = undefined;
            return arrayBufferToDataUrl(media.bytes, media.mimeType);
          } catch (error) {
            this.logCoverFailure(item, 'avatar', error, startedAt, baseTags);
            return null;
          }
        }

        const msgId = item.msgId ?? 0;
        let photoInfo = item.photoInfo;
        let videoInfo = item.videoInfo;
        let fileInfo = item.fileInfo;

        // 若缺少媒体定位信息但存在 msgId，先拉取单条上下文以补全新鲜 fileReference
        if (!photoInfo && !videoInfo && !fileInfo && msgId > 0) {
          try {
            const page = await telegramBusClient.chatRead.getHistoryAround(accountId, peer, msgId, 3);
            const found = page.messages.find((m) => m.id === msgId) ?? page.messages[0];
            if (found?.media) {
              photoInfo = found.media.photo;
              videoInfo = found.media.video;
              fileInfo = found.media.file;
              item.photoInfo = photoInfo;
              item.videoInfo = videoInfo;
              item.fileInfo = fileInfo;
            }
            this.logCover(
              'search_history_refresh',
              photoInfo || videoInfo || fileInfo ? 'INFO' : 'WARN',
              {
                ...baseTags,
                returned: page.messages.length,
                gotPhoto: Boolean(photoInfo),
                gotVideo: Boolean(videoInfo),
                gotFile: Boolean(fileInfo),
              },
              '为补全媒体定位信息拉取了消息上下文',
              Date.now() - startedAt,
            );
          } catch (error) {
            const info = classifyTelegramError(error);
            this.logCover(
              'search_history_refresh_error',
              'WARN',
              {
                ...baseTags,
                branch: 'history',
                bucket: info.bucket,
                code: info.code,
                retryable: info.retryable,
              },
              info.description,
              Date.now() - startedAt,
            );
          }
        }

        if (!photoInfo && !videoInfo && !fileInfo) {
          this.logCoverSkipped(item, 'NO_MEDIA', baseTags);
          return null;
        }

        let branch = 'none';
        let sizeType = '';
        let mediaFile: TgMediaFile | null = null;

        try {
          if (photoInfo) {
            const size = coverSizeOf(photoInfo);
            branch = 'photo';
            sizeType = size.type;
            mediaFile = await telegramBusClient.cover.getPhoto(accountId, peer, msgId, photoInfo, size, 'search');
          } else if (videoInfo) {
            const source = videoPreviewOf(videoInfo);
            if (source?.kind === 'photo') {
              const size = coverSizeOf(source.photo);
              branch = 'video_cover';
              sizeType = size.type;
              mediaFile = await telegramBusClient.cover.getPhoto(accountId, peer, msgId, source.photo, size, 'search');
            } else if (source?.kind === 'document') {
              branch = 'video_doc_thumb';
              sizeType = source.size.type;
              mediaFile = await telegramBusClient.cover.getDocumentThumb(accountId, peer, msgId, videoInfo, source.size, 'search');
            } else {
              this.logCoverSkipped(item, 'NO_THUMB_SOURCE', { ...baseTags, branch: 'video' });
              return null;
            }
          } else if (fileInfo?.preview) {
            branch = 'file_doc_thumb';
            sizeType = fileInfo.preview.type;
            mediaFile = await telegramBusClient.cover.getDocumentThumb(accountId, peer, msgId, fileInfo, fileInfo.preview, 'search');
          } else {
            this.logCoverSkipped(item, 'NO_THUMB_SOURCE', { ...baseTags, branch: 'file' });
            return null;
          }
        } catch (error) {
          this.logCoverFailure(item, branch, error, startedAt, { ...baseTags, sizeType });
          return null;
        }

        if (!mediaFile || !mediaFile.bytes || mediaFile.bytes.byteLength === 0) {
          this.logCoverSkipped(item, 'EMPTY_BYTES', { ...baseTags, branch, sizeType });
          return null;
        }

        this.logCover(
          'search_cover_ok',
          'INFO',
          {
            ...baseTags,
            branch,
            sizeType,
            bytes: mediaFile.bytes.byteLength,
            mime: mediaFile.mimeType,
          },
          '搜索结果高清缩略图加载成功',
          Date.now() - startedAt,
        );
        item.hdThumbError = undefined;
        return arrayBufferToDataUrl(mediaFile.bytes, mediaFile.mimeType);
      },
    });
  }
}

export const aggregateSearchDataSource = new AggregateSearchDataSource();
