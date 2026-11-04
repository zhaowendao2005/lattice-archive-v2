/**
 * ============================================================================
 * 聚合搜索数据源接线器 (Aggregate Search Data Source Singleton)
 * ============================================================================
 * 定位：归档与聚合搜索业务域唯一的全局单例连接器。
 * 职责：
 * 1. 封面与会话范围薄桥接；
 * 2. 托管流式检索的取消句柄；
 * 3. 统一托管拖拽悬停展开定时器，保证视图层零本地 `ref`。
 */
import type {
  AggregateSearchResultItem,
  SearchScopeSessionDto,
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
import type { TgMediaFile, TgPeerKey, TgPeerRef } from '@/stores/chat/types';
import { useSessionManagerStore } from '../stores/sessionManagerStore';


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

class AggregateSearchDataSource {
  private activeAbortController: AbortController | null = null;
  private treeExpandTimer: number | null = null;


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
        accentClass: 'bg-accent text-primary',
        avatar: dialog.avatar ? { photoId: dialog.avatar.photoId, dcId: dialog.avatar.dcId } : undefined,
        peerRef: dialog.peer,
        username: dialog.username,
        credentialState: 'joined',
      });
    }

    for (const cred of sessionManagerStore.tempCredentials) {
      if (cred.accountId !== chatStore.accountId) continue;
      realSessions.push({
        id: cred.peerKey,
        title: cred.title,
        initials: cred.title.slice(0, 2).toUpperCase(),
        kind: 'credential_only',
        peerTypeLabel: cred.peerType === 'channel' ? '临时频道' : '临时群组',
        credentialBadge: cred.state === 'temp_auto_renew' ? '自动续期' : '临时凭据',
        handleOrHash: cred.username ? `@${cred.username}` : `+${cred.inviteHash ?? 'temp'}`,
        itemCountLabel: cred.participantsCount ? `${cred.participantsCount} 成员` : '凭据直连',
        accentClass: 'bg-accent text-primary',
        accountId: cred.accountId,
        username: cred.username,
        inviteHash: cred.inviteHash,
        credentialState: cred.state,
        peekExpiresAt: cred.peekExpiresAt,
      });
    }

    return realSessions;
  }

  /**
   * 右栏会话范围的真实头像：只给当前虚拟窗口内的会话调用，滚出窗口即中止。
   * 没有头像定位信息（例如临时凭据会话）时返回 null，由视图回退为 initials 方块。
   */
  async fetchScopeAvatarDataUrl(session: SearchScopeSessionDto, signal?: AbortSignal): Promise<string | null> {
    const avatar = session.avatar;
    if (!avatar) return null;
    const chatStore = useChatStore();
    const accountId = session.accountId || chatStore.accountId;
    if (!accountId || !chatStore.isOnline) return null;
    const peer = session.peerRef ?? peerRefFromKey(session.id as TgPeerKey);
    if (!peer) return null;
    return coverImageBus.request<string | null>({
      key: `scope-avatar-${accountId}-${session.id}`,
      lane: 'chat_avatars',
      priority: 12,
      signal,
      fetch: async () => {
        if (signal?.aborted) return null;
        try {
          const media = await telegramBusClient.cover.getAvatar(
            accountId, peer, avatar.photoId, avatar.dcId, undefined, undefined, { signal },
          );
          if (signal?.aborted || !media?.bytes || media.bytes.byteLength === 0) return null;
          return arrayBufferToDataUrl(media.bytes, media.mimeType);
        } catch (error) {
          if (signal?.aborted) return null;
          const info = classifyTelegramError(error);
          this.logCover('scope_avatar_error', 'WARN', { sessionId: session.id, bucket: info.bucket, code: info.code }, info.description);
          return null;
        }
      },
    });
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
  async fetchHighResThumbnailDataUrl(item: AggregateSearchResultItem, signal?: AbortSignal, generation = 0): Promise<string | null> {
    const startedAt = Date.now();
    return coverImageBus.request<string | null>({
      key: `search-hd-${item.originAccountId ?? useChatStore().accountId}-${item.id}-${generation}`,
      lane: 'search',
      priority: 30,
      signal,
      fetch: async () => {
        if (signal?.aborted) return null;
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
              undefined, undefined, { signal },
            );
            if (signal?.aborted) return null;
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
            if (signal?.aborted) return null;
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
            const page = await telegramBusClient.chatRead.getHistoryAround(accountId, peer, msgId, 3, { signal });
            if (signal?.aborted) return null;
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
            if (signal?.aborted) return null;
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
            mediaFile = await telegramBusClient.cover.getPhoto(accountId, peer, msgId, photoInfo, size, 'search', { signal });
          } else if (videoInfo) {
            const source = videoPreviewOf(videoInfo);
            if (source?.kind === 'photo') {
              const size = coverSizeOf(source.photo);
              branch = 'video_cover';
              sizeType = size.type;
              mediaFile = await telegramBusClient.cover.getPhoto(accountId, peer, msgId, source.photo, size, 'search', { signal });
            } else if (source?.kind === 'document') {
              branch = 'video_doc_thumb';
              sizeType = source.size.type;
              mediaFile = await telegramBusClient.cover.getDocumentThumb(accountId, peer, msgId, videoInfo, source.size, 'search', { signal });
            } else {
              this.logCoverSkipped(item, 'NO_THUMB_SOURCE', { ...baseTags, branch: 'video' });
              return null;
            }
          } else if (fileInfo?.preview) {
            branch = 'file_doc_thumb';
            sizeType = fileInfo.preview.type;
            mediaFile = await telegramBusClient.cover.getDocumentThumb(accountId, peer, msgId, fileInfo, fileInfo.preview, 'search', { signal });
          } else {
            this.logCoverSkipped(item, 'NO_THUMB_SOURCE', { ...baseTags, branch: 'file' });
            return null;
          }
        } catch (error) {
          if (signal?.aborted) return null;
          this.logCoverFailure(item, branch, error, startedAt, { ...baseTags, sizeType });
          return null;
        }

        if (signal?.aborted) return null;
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
