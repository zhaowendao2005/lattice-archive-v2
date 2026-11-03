/**
 * ============================================================================
 * 聚合搜索数据源接线器 (Aggregate Search Data Source Singleton)
 * ============================================================================
 * 定位：归档与聚合搜索业务域唯一的全局单例连接器。
 * 职责：
 * 1. 三级混合检索管线（L0 本地磁贴与临时凭据索引 + L1 跨账号 MTProto messages.Search/SearchGlobal + 开发态 Mock 隔离）；
 * 2. 提供支持 `AbortSignal` 的分块流式检索异步生成器 (`streamSearchPage`)；
 * 3. 统一托管触底懒加载的 `IntersectionObserver` 句柄与拖拽悬停展开定时器，保证视图层零本地 `ref`。
 */
import {
  MOCK_SCOPE_SESSIONS,
  MOCK_SEARCH_RESULTS_POOL,
  SEARCH_CATEGORY_OPTIONS,
} from '../mocks/aggregateSearchMock';
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

const STREAM_CHUNK_SIZE = 4;
const STREAM_STEP_DELAY_MS = 60;
const isMockDev =
  Boolean(import.meta.env.DEV) && import.meta.env.VITE_ENABLE_MOCK_DATA === 'true';

/** 跨分页检索游标：同一查询签名下复用 Telegram 的 offset 游标，避免每页都从头发起请求。 */
interface SearchCursorState {
  signature: string;
  offsetId?: number;
  offsetPeer?: TgPeerRef;
  offsetRate?: number;
  totalCount: number;
  deliveredIds: Set<string>;
  pagesFetched: number;
}

function buildSearchSignature(accountId: string, query: StreamingSearchQuery): string {
  return JSON.stringify({
    accountId,
    keyword: query.keyword.trim(),
    categories: [...query.preCategories].sort(),
    scopes: [...query.scopeSessionIds].sort(),
    minDate: query.minDate ?? 0,
    maxDate: query.maxDate ?? 0,
    fromPeerKey: query.fromPeerKey ?? '',
    topMsgId: query.topMsgId ?? 0,
  });
}

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

function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
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
  private sentinelObserver: IntersectionObserver | null = null;
  private treeExpandTimer: number | null = null;
  private searchCursor: SearchCursorState | null = null;

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
   * 按查询条件过滤匹配结果全集（搜索前筛选在此阶段直接参与检索）
   */
  private filterPool(pool: AggregateSearchResultItem[], query: StreamingSearchQuery): AggregateSearchResultItem[] {
    const kw = query.keyword.trim().toLowerCase();
    const hasCategoryFilter = query.preCategories.length > 0;
    const categorySet = new Set(query.preCategories);
    const hasScopeFilter = query.scopeSessionIds.length > 0;
    const scopeSet = new Set(query.scopeSessionIds);

    return pool.filter((item) => {
      if (hasCategoryFilter && !categorySet.has(item.category)) {
        return false;
      }
      if (hasScopeFilter && !scopeSet.has(item.sessionId)) {
        return false;
      }
      if (kw) {
        const hit =
          item.title.toLowerCase().includes(kw) ||
          item.snippet.toLowerCase().includes(kw) ||
          item.extension.toLowerCase().includes(kw) ||
          item.sessionTitle.toLowerCase().includes(kw) ||
          item.categoryLabel.toLowerCase().includes(kw);
        if (!hit) return false;
      }
      return true;
    });
  }

  /**
   * 流式分页检索生成器：融合 MTProto 实时检索与本地缓存池
   *
   * 分页策略（修复「永远只有 15 条」）：
   * - 第 1 页：从服务端取一页，记录 nextOffsetId / nextOffsetPeer / nextRate；
   * - 第 N 页：携带上一页返回的 offset 游标继续请求，而不是从 offset 0 重来；
   * - 查询签名（关键词/类型/范围/时间）变化时自动重置游标。
   */
  async *streamSearchPage(
    query: StreamingSearchQuery,
    signal: AbortSignal,
  ): AsyncGenerator<StreamingSearchChunk, void, unknown> {
    const pageStartedAt = Date.now();
    const chatStore = useChatStore();
    const accountId = chatStore.accountId;
    const signature = buildSearchSignature(accountId ?? '', query);
    const isFirstPage =
      query.page <= 1 || !this.searchCursor || this.searchCursor.signature !== signature;
    if (isFirstPage) {
      this.searchCursor = {
        signature,
        totalCount: 0,
        deliveredIds: new Set(),
        pagesFetched: 0,
      };
    }
    const cursor = this.searchCursor!;
    cursor.pagesFetched += 1;

    const queryMeta = {
      page: query.page,
      pageSize: query.pageSize,
      keywordLength: query.keyword.trim().length,
      categories: query.preCategories.join(',') || 'all',
      scopeCount: query.scopeSessionIds.length,
      accountId: accountId ?? 'none',
      cursorOffsetId: isFirstPage ? 0 : (cursor.offsetId ?? 0),
    };
    this.logSearch('stream_page_start', 'INFO', queryMeta, '开始检索一页搜索结果');

    let pageItems: AggregateSearchResultItem[] = [];
    let totalMatched = cursor.totalCount;
    let hasMore = false;
    let source: 'mtproto' | 'mock' | 'none' = 'none';
    let rawCount = 0;

    // 1. 若已连接真实 Telegram 账号，发起 MTProto messages.Search / SearchGlobal
    if (accountId && chatStore.isOnline) {
      let filterType: 'all' | 'video' | 'Photo' | 'document' = 'all';
      if (query.preCategories.length === 1) {
        if (query.preCategories[0] === 'video') filterType = 'video';
        else if (query.preCategories[0] === 'image') filterType = 'Photo';
        else if (query.preCategories[0] === 'text') filterType = 'document';
      }

      const offsetId = isFirstPage ? undefined : cursor.offsetId;
      const offsetPeer = isFirstPage ? undefined : cursor.offsetPeer;
      const offsetRate = isFirstPage ? undefined : cursor.offsetRate;

      try {
        let res: {
          messages: TgMessageDto[];
          dialogs?: Record<TgPeerKey, { title: string; peer: TgPeerRef }>;
          totalCount?: number;
          nextOffsetId?: number;
          nextOffsetPeer?: TgPeerRef;
          nextRate?: number;
          hasMore?: boolean;
        };

        if (query.scopeSessionIds.length === 1) {
          const targetKey = query.scopeSessionIds[0] as TgPeerKey;
          const dialog = chatStore.dialogs[targetKey];
          if (!dialog) {
            this.logSearch(
              'stream_scope_missing',
              'WARN',
              { ...queryMeta, scopePeer: targetKey },
              '选中会话不在本地会话表中，无法发起单会话检索（可能仅为凭据会话）',
            );
            res = { messages: [], totalCount: 0, hasMore: false };
          } else {
            res = await telegramBusClient.search.searchMessages(accountId, {
              peer: dialog.peer,
              query: query.keyword,
              filterType,
              minDate: query.minDate,
              maxDate: query.maxDate,
              offsetId,
              limit: query.pageSize,
            });
          }
        } else {
          res = await telegramBusClient.search.searchMessages(accountId, {
            query: query.keyword,
            filterType,
            minDate: query.minDate,
            maxDate: query.maxDate,
            offsetId,
            offsetRate,
            offsetPeer,
            limit: query.pageSize,
          });
        }

        rawCount = res.messages.length;
        const mapped: AggregateSearchResultItem[] = [];
        for (const msg of res.messages) {
          if (query.scopeSessionIds.length === 1) {
            const targetKey = query.scopeSessionIds[0] as TgPeerKey;
            const dialog = chatStore.dialogs[targetKey];
            const peerDto = res.dialogs?.[msg.peerKey] ?? dialog;
            if (!peerDto) continue;
            mapped.push(
              mapTgMessageToSearchResult(msg, peerDto.title, 'joined', {
                accountId,
                peerRef: peerDto.peer,
              }),
            );
          } else {
            const dialog = chatStore.dialogs[msg.peerKey] ?? res.dialogs?.[msg.peerKey];
            mapped.push(
              mapTgMessageToSearchResult(
                msg,
                dialog?.title ?? msg.peerKey,
                chatStore.dialogs[msg.peerKey] ? 'joined' : 'credential_only',
                {
                  accountId,
                  peerRef: dialog?.peer,
                },
              ),
            );
          }
        }

        // 跨页去重：Telegram offset 在极端情况下可能返回重复消息
        const beforeDedupe = mapped.length;
        pageItems = mapped.filter((item) => {
          if (cursor.deliveredIds.has(item.id)) return false;
          cursor.deliveredIds.add(item.id);
          return true;
        });
        const dedupedCount = beforeDedupe - pageItems.length;

        totalMatched = Math.max(res.totalCount ?? 0, cursor.totalCount, cursor.deliveredIds.size);
        cursor.totalCount = totalMatched;
        cursor.offsetId = res.nextOffsetId;
        cursor.offsetPeer = res.nextOffsetPeer;
        cursor.offsetRate = res.nextRate;
        hasMore = Boolean(res.hasMore) && pageItems.length > 0;
        source = 'mtproto';

        this.logSearch(
          'stream_page_ok',
          pageItems.length > 0 ? 'INFO' : 'WARN',
          {
            ...queryMeta,
            source,
            rawCount,
            mappedCount: mapped.length,
            dedupedCount,
            itemCount: pageItems.length,
            totalCount: totalMatched,
            hasMore,
            nextOffsetId: cursor.offsetId ?? 0,
            nextRate: cursor.offsetRate ?? 0,
            nextHasPeer: Boolean(cursor.offsetPeer),
            withThumb: pageItems.filter((item) => Boolean(item.thumbnailUrl)).length,
            withoutThumb: pageItems.filter((item) => !item.thumbnailUrl).length,
            imageCount: pageItems.filter((item) => item.category === 'image').length,
            videoCount: pageItems.filter((item) => item.category === 'video').length,
            textCount: pageItems.filter((item) => item.category === 'text').length,
            otherCount: pageItems.filter((item) => item.category === 'other').length,
            errorBucket: '',
          },
          pageItems.length > 0
            ? 'MTProto 检索返回一页结果'
            : 'MTProto 检索返回空页（可能已到末页或过滤条件过严）',
          Date.now() - pageStartedAt,
        );
      } catch (error) {
        const info = classifyTelegramError(error);
        this.logSearch(
          'stream_page_error',
          'ERROR',
          {
            ...queryMeta,
            source: 'mtproto',
            bucket: info.bucket,
            code: info.code,
            retryable: info.retryable,
            errorBucket: info.bucket,
          },
          info.description,
          Date.now() - pageStartedAt,
        );
        // 交给 Store 决定回滚页码 / 展示错误；游标保持上一页状态不被污染
        throw error;
      }
    } else {
      const reason: CoverUnavailableReason = !accountId ? 'NO_ACCOUNT' : 'OFFLINE';
      const info = describeCoverUnavailable(reason);
      this.logSearch(
        'stream_page_skipped',
        'WARN',
        {
          ...queryMeta,
          source: 'none',
          bucket: info.bucket,
          code: info.code,
          errorBucket: info.bucket,
        },
        info.description,
      );
    }

    // 2. 开发态且开启 Mock 开关时，合并 Mock 样本池（仅用于无真实账号的本地演示）
    if (isMockDev) {
      const mockPool = this.filterPool(MOCK_SEARCH_RESULTS_POOL, query);
      const mockStart = (query.page - 1) * query.pageSize;
      const mockPage = mockPool.slice(mockStart, mockStart + query.pageSize);
      if (mockPage.length > 0) {
        pageItems.push(...mockPage);
        source = source === 'mtproto' ? 'mtproto' : 'mock';
        totalMatched = Math.max(totalMatched, cursor.deliveredIds.size + mockPool.length);
        hasMore = hasMore || mockStart + mockPage.length < mockPool.length;
      }
    }

    if (pageItems.length === 0) {
      const ok = await sleepWithAbort(40, signal);
      if (!ok) return;
      this.logSearch(
        'stream_page_empty',
        hasMore ? 'WARN' : 'DEBUG',
        { ...queryMeta, source, totalCount: totalMatched, hasMore },
        '本页没有可展示结果',
        Date.now() - pageStartedAt,
      );
      yield {
        items: [],
        totalMatched,
        hasMore: false,
        isFinalChunkOfPage: true,
      };
      return;
    }

    for (let offset = 0; offset < pageItems.length; offset += STREAM_CHUNK_SIZE) {
      const ok = await sleepWithAbort(STREAM_STEP_DELAY_MS, signal);
      if (!ok || signal.aborted) return;

      const chunkItems = pageItems.slice(offset, offset + STREAM_CHUNK_SIZE);
      const isFinalChunkOfPage = offset + STREAM_CHUNK_SIZE >= pageItems.length;

      this.logSearch(
        'stream_chunk',
        'DEBUG',
        {
          ...queryMeta,
          source,
          offset,
          chunkSize: chunkItems.length,
          totalCount: totalMatched,
          hasMore,
          isFinalChunkOfPage,
        },
        '推送一个结果分片',
      );

      yield {
        items: chunkItems,
        totalMatched,
        hasMore,
        isFinalChunkOfPage,
      };
    }

    this.logSearch(
      'stream_page_done',
      'INFO',
      {
        ...queryMeta,
        source,
        itemCount: pageItems.length,
        totalCount: totalMatched,
        hasMore,
      },
      '本页结果推送完成',
      Date.now() - pageStartedAt,
    );
  }

  /**
   * 绑定底部懒加载哨兵 DOM 节点（由自定义指令或挂载回调委托，视图层零 ref）
   */
  bindLazyLoadSentinel(
    el: HTMLElement | null,
    scrollRoot: HTMLElement | null,
    onReachBottom: () => void,
  ): void {
    this.unbindLazyLoadSentinel();
    if (!el || typeof IntersectionObserver === 'undefined') return;

    this.sentinelObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onReachBottom();
          }
        }
      },
      {
        root: scrollRoot,
        rootMargin: '0px 0px 180px 0px',
        threshold: 0.01,
      },
    );
    this.sentinelObserver.observe(el);
  }

  unbindLazyLoadSentinel(): void {
    if (this.sentinelObserver) {
      this.sentinelObserver.disconnect();
      this.sentinelObserver = null;
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
