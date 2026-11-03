/**
 * [DATA SOURCE] TelegramBusClient：主线程唯一的 Telegram 业务总线入口（薄桥接）
 *
 * - 按 9 条业务总线分组（account / chatRead / search / cover / mediaAsset / stream / chatCommand / bot / vault），
 *   每次调用生成统一上下文（requestId / traceId / accountId / priority / source），经 mtprotoHub 发往 Worker BusRouter；
 * - 只做参数瘦身（剥离缩略图 data URL 等大字段）与上下文组装，不含任何业务逻辑；
 * - 上游 Store 不知道使用哪个 Api.* 方法、是否需要 resolveInputPeer / file_reference 刷新 / FloodWait 退避；
 * - 聊天内容只在设备本地流转，绝不经过 Lattice 远端。
 */
import { mtprotoHub, TelegramBusRequestError, type BusRequestOptions } from './mtprotoBridge';
import type {
  TgChatUpdate,
  TgDialogCursor,
  TgDocumentLocation,
  TgMessageDto,
  TgPeerKey,
  TgPeerRef,
  TgPhotoLocation,
  TgPhotoSize,
  TgUpdatesState,
} from '@/worker/local/chatProtocol';
import type { BusInput, BusName, BusOpName, BusOutput, CoverOrigin, SearchFilter } from '@/worker/local/telegram/contracts/buses';
import type { TelegramBusPriority } from '@/worker/local/telegram/contracts/busContext';

type UpdatesListener = (accountId: string, updates: TgChatUpdate[], state?: TgUpdatesState) => void;

/** 每次调用可选的上下文覆盖：发起方名称、优先级、取消信号。 */
export interface BusCallOptions {
  source?: string;
  priority?: TelegramBusPriority;
  signal?: AbortSignal;
}

/** 完整文件下载的无进度超时：弱网下只要还在推进就不会被判超时。 */
const DOCUMENT_IDLE_TIMEOUT_MS = 30_000;

const ERROR_MESSAGES: [pattern: string, message: string][] = [
  ['TG_NOT_CONNECTED', 'Telegram 尚未连接，连接恢复后会自动加载'],
  ['TG_REQUEST_TIMEOUT', 'Telegram 请求超时，请稍后重试'],
  ['TG_CANCELED', '请求已取消'],
  ['TG_OWNER_CANNOT_LEAVE', '你是该群组或频道的创建者，暂不支持直接退出，请先在官方客户端转让所有权'],
  ['TG_CANNOT_ARCHIVE_SELF', '收藏夹不支持归档'],
  ['TG_JOIN_UNSUPPORTED', '仅支持直接加入公开频道或超级群组'],
  ['TG_LEAVE_UNSUPPORTED', '私聊会话不支持退出群组操作'],
  ['CHANNELS_TOO_MUCH', '加入的频道或超级群组数量已达上限'],
  ['USERS_TOO_MUCH', '该群组人数已满，无法加入'],
  ['USER_BANNED_IN_CHANNEL', '你已被禁止在该频道或群组发言/加入'],
  ['USER_ALREADY_PARTICIPANT', '你已是该群组或频道成员'],
  ['USER_NOT_PARTICIPANT', '你已不在该群组或频道中'],
  ['USERNAME_NOT_OCCUPIED', '未找到该公开用户名对应的会话'],
  ['USERNAME_INVALID', '输入的用户名格式无效'],
  ['FLOOD_WAIT', '请求过于频繁，Telegram 要求稍后再试'],
  ['CHANNEL_PRIVATE', '无权访问该私有频道或群组（可能已退出或被移出）'],
  ['CHAT_FORBIDDEN', '无权访问该会话'],
  ['CHAT_ADMIN_REQUIRED', '需要管理员权限才能执行此操作'],
  ['PEER_ID_INVALID', '无法识别该会话，请从会话列表重新打开'],
  ['CHANNEL_INVALID', '无法识别该频道，请从会话列表重新打开'],
  ['AUTH_KEY', 'Telegram 授权已失效，请在设置中重新添加本设备'],
  ['SESSION_REVOKED', 'Telegram 授权已失效，请在设置中重新添加本设备'],
  ['TG_MEDIA_UNAVAILABLE', '媒体已不可用（消息可能已被删除）'],
  ['FILE_REFERENCE', '媒体引用已过期，请重试'],
  ['INVITE_HASH_EXPIRED', '该邀请链接已过期'],
  ['INVITE_HASH_INVALID', '无效的邀请链接'],
  ['INVITE_HASH_EMPTY', '邀请链接不能为空'],
  ['CHAT_WRITE_FORBIDDEN', '当前会话不允许发送消息'],
  ['CHAT_SEND_PLAIN_FORBIDDEN', '当前群组限制了发送文字消息'],
  ['SLOWMODE_WAIT', '群组开启了慢速模式，请稍后再发送'],
  ['BOT_RESPONSE_TIMEOUT', '机器人响应超时，请稍后重试'],
  ['MESSAGE_ID_INVALID', '目标消息不存在或已被删除'],
];

const stripSize = (size: TgPhotoSize): TgPhotoSize => ({ type: size.type, width: size.width, height: size.height, bytes: size.bytes });
const stripDocument = (document: TgDocumentLocation): TgDocumentLocation => ({ id: document.id, accessHash: document.accessHash, fileReference: document.fileReference, dcId: document.dcId });
const stripPhoto = (photo: TgPhotoLocation): TgPhotoLocation => ({ id: photo.id, accessHash: photo.accessHash, fileReference: photo.fileReference, dcId: photo.dcId });
const stripCursor = (cursor: TgDialogCursor | undefined): TgDialogCursor | undefined =>
  cursor ? { offsetDate: cursor.offsetDate, offsetId: cursor.offsetId, offsetPeer: { ...cursor.offsetPeer } } : undefined;
const stripPeer = (peer: TgPeerRef): TgPeerRef => ({ type: peer.type, id: peer.id, accessHash: peer.accessHash });
const stripState = (state: TgUpdatesState | null): TgUpdatesState | null =>
  state ? { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq } : null;

let traceSeq = 0;
function newTraceId() {
  traceSeq = (traceSeq + 1) & 0xffff;
  return `b${(Date.now() & 0xfffff).toString(16)}${traceSeq.toString(16).padStart(4, '0')}`;
}

/** 组装统一上下文并发出请求；priority 缺省时由 Worker 路由表按操作决定。 */
function call<B extends BusName, O extends BusOpName<B>>(
  bus: B,
  op: O,
  accountId: string,
  input: BusInput<B, O>,
  options: BusCallOptions & Pick<BusRequestOptions, 'onProgress' | 'idleTimeoutMs'> = {},
): Promise<BusOutput<B, O>> {
  const context = {
    requestId: crypto.randomUUID(),
    traceId: newTraceId(),
    accountId,
    priority: options.priority,
    source: options.source ?? `${bus}.${op}`,
  };
  return mtprotoHub.bridge().requestBus(bus, op, input, context, {
    signal: options.signal,
    onProgress: options.onProgress,
    idleTimeoutMs: options.idleTimeoutMs,
  });
}

export const telegramBusClient = {
  /** B1 AccountSessionBus */
  account: {
    probeAccountHealth(accountId: string, options?: BusCallOptions) {
      return call('account', 'probeHealth', accountId, {}, options);
    },
    /** 6 步同机回环生成 PendingSlot 备用热槽位。 */
    spawnPendingSlot(
      accountId: string,
      apiId: number,
      apiHash: string,
      password2FA?: string,
      deviceFingerprint?: { deviceModel: string; systemVersion: string; appVersion: string; langCode: string; systemLangCode: string },
      options?: BusCallOptions,
    ) {
      return call('account', 'spawnPendingSlot', accountId, {
        apiId,
        apiHash,
        twoFaPassword: password2FA,
        deviceFingerprint: deviceFingerprint ?? { deviceModel: 'Desktop', systemVersion: 'Mac OS X 14.5', appVersion: '5.12.3', langCode: 'zh-hans', systemLangCode: 'zh-CN' },
      }, options);
    },
  },

  /** B2 ChatReadBus */
  chatRead: {
    getDialogs(accountId: string, folderId: 0 | 1, cursor: TgDialogCursor | undefined, limit: number, options?: BusCallOptions) {
      return call('chatRead', 'getDialogs', accountId, { folderId, cursor: stripCursor(cursor), limit }, options);
    },
    getHistory(accountId: string, peer: TgPeerRef, offsetId: number, limit: number, options?: BusCallOptions) {
      return call('chatRead', 'getHistory', accountId, { peer: stripPeer(peer), offsetId, limit }, options);
    },
    getHistoryAround(accountId: string, peer: TgPeerRef, messageId: number, limit: number, options?: BusCallOptions) {
      return call('chatRead', 'getHistoryAround', accountId, { peer: stripPeer(peer), messageId, limit }, options);
    },
    syncFrom(accountId: string, state: TgUpdatesState | null, options?: BusCallOptions) {
      return call('chatRead', 'syncFrom', accountId, { state: stripState(state) }, options);
    },
  },

  /** B3 SearchBus：单会话 messages.Search 或全局 messages.SearchGlobal。 */
  search: {
    searchMessages(
      accountId: string,
      query: {
        peer?: TgPeerRef;
        query: string;
        filterType?: 'all' | 'photo_video' | 'video' | 'document' | 'Photo' | 'photo' | 'url' | 'voice' | 'music';
        minDate?: number;
        maxDate?: number;
        offsetId?: number;
        offsetRate?: number;
        offsetPeer?: TgPeerRef;
        limit: number;
      },
      options?: BusCallOptions,
    ) {
      const raw = query.filterType;
      const filter: SearchFilter | undefined = raw === 'Photo' || raw === 'photo_video' ? 'photo' : raw === 'voice' ? 'music' : raw;
      return call('search', 'searchMessages', accountId, {
        peer: query.peer ? stripPeer(query.peer) : undefined,
        query: query.query,
        filter,
        minDate: query.minDate,
        maxDate: query.maxDate,
        offsetId: query.offsetId,
        offsetRate: query.offsetRate,
        offsetPeer: query.offsetPeer ? stripPeer(query.offsetPeer) : undefined,
        limit: query.limit,
      }, options);
    },
  },

  /** B4 CoverBus：头像与 Tier-1 细图。 */
  cover: {
    getAvatar(accountId: string, peer: TgPeerRef, photoId: string, dcId: number, containerPeer?: TgPeerRef, messageId?: number, options?: BusCallOptions) {
      return call('cover', 'avatar', accountId, { peer: stripPeer(peer), photoId, dcId, containerPeer: containerPeer ? stripPeer(containerPeer) : undefined, messageId }, options);
    },
    /** origin=search 时 Worker 允许其使用封面池中为搜索结果保留的槽位。 */
    getPhoto(accountId: string, peer: TgPeerRef, messageId: number, photo: TgPhotoLocation, size: TgPhotoSize, origin: CoverOrigin = 'chat', options?: BusCallOptions) {
      return call('cover', 'photo', accountId, { peer: stripPeer(peer), messageId, photo: stripPhoto(photo), size: stripSize(size), origin }, options);
    },
    getDocumentThumb(accountId: string, peer: TgPeerRef, messageId: number, document: TgDocumentLocation, size: TgPhotoSize, origin: CoverOrigin = 'chat', options?: BusCallOptions) {
      return call('cover', 'documentThumb', accountId, { peer: stripPeer(peer), messageId, document: stripDocument(document), size: stripSize(size), origin }, options);
    },
  },

  /** B5 MediaAssetBus：完整文件，进度经 onProgress 回调；30 s 内无任何进度视为超时。 */
  mediaAsset: {
    getDocument(
      accountId: string,
      peer: TgPeerRef,
      messageId: number,
      document: TgDocumentLocation & { size: number; mimeType: string },
      options: BusCallOptions & { onProgress?: (loaded: number, total: number) => void } = {},
    ) {
      return call('mediaAsset', 'document', accountId, {
        peer: stripPeer(peer),
        messageId,
        document: stripDocument(document),
        size: document.size,
        mimeType: document.mimeType,
      }, { ...options, idleTimeoutMs: DOCUMENT_IDLE_TIMEOUT_MS });
    },
  },

  /** B6 StreamBus：渐进式流播放的单个 512 KiB 对齐分片。 */
  stream: {
    getDocumentPart(
      accountId: string,
      peer: TgPeerRef,
      messageId: number,
      document: TgDocumentLocation & { size: number; mimeType: string },
      offset: number,
      limit: number,
      options: BusCallOptions = {},
    ) {
      return call('stream', 'part', accountId, {
        peer: stripPeer(peer),
        messageId,
        document: stripDocument(document),
        offset,
        limit,
        size: document.size,
        mimeType: document.mimeType,
      }, { ...options, idleTimeoutMs: DOCUMENT_IDLE_TIMEOUT_MS });
    },
  },

  /** B7 ChatCommandBus：全部为用户主动触发的写操作。 */
  chatCommand: {
    setDialogArchived(accountId: string, peer: TgPeerRef, archived: boolean, options?: BusCallOptions) {
      return call('chatCommand', 'setArchived', accountId, { peer: stripPeer(peer), archived }, options);
    },
    batchSetDialogsArchived(accountId: string, peers: TgPeerRef[], archived: boolean, options?: BusCallOptions) {
      return call('chatCommand', 'batchSetArchived', accountId, { peers: peers.map(stripPeer), archived }, options);
    },
    resolveUsername(accountId: string, username: string, options?: BusCallOptions) {
      return call('chatCommand', 'resolveUsername', accountId, { username }, options);
    },
    joinChat(accountId: string, peer: TgPeerRef, options?: BusCallOptions) {
      return call('chatCommand', 'join', accountId, { peer: stripPeer(peer) }, options);
    },
    leaveChat(accountId: string, peer: TgPeerRef, options?: BusCallOptions) {
      return call('chatCommand', 'leave', accountId, { peer: stripPeer(peer) }, options);
    },
    /** 删除会话（私聊支持 revoke；基础群组 / 频道转为退出）。 */
    deleteChat(accountId: string, peer: TgPeerRef, revoke = true, options?: BusCallOptions) {
      return call('chatCommand', 'deleteChat', accountId, { peer: stripPeer(peer), revoke }, options);
    },
    sendMessage(accountId: string, peer: TgPeerRef, text: string, replyToMsgId?: number, options?: BusCallOptions) {
      return call('chatCommand', 'sendMessage', accountId, { peer: stripPeer(peer), text, replyToMsgId }, options);
    },
    checkChatInvite(accountId: string, hash: string, options?: BusCallOptions) {
      return call('chatCommand', 'checkInvite', accountId, { hash }, options);
    },
    importChatInvite(accountId: string, hash: string, options?: BusCallOptions) {
      return call('chatCommand', 'importInvite', accountId, { hash }, options);
    },
    batchCheckChannels(accountId: string, peers: TgPeerRef[], options?: BusCallOptions) {
      return call('chatCommand', 'batchCheckChannels', accountId, { channels: peers.map(stripPeer) }, options);
    },
  },

  /** B8 BotInteractionBus */
  bot: {
    metadata(accountId: string, message: TgMessageDto, windowMessages: TgMessageDto[], fallbackLastQuery?: string, options?: BusCallOptions) {
      return call('bot', 'metadata', accountId, { message, windowMessages, fallbackLastQuery }, options);
    },
    findNextButton(accountId: string, rows: import('@/worker/local/chatProtocol').TgInlineButton[][], nextPageNum: number, options?: BusCallOptions) {
      return call('bot', 'findNextButton', accountId, { rows, nextPageNum }, options);
    },
    extractCandidates(accountId: string, message: TgMessageDto, pageNum: number, options?: BusCallOptions) {
      return call('bot', 'extractCandidates', accountId, { message, pageNum }, options);
    },
    startBot(accountId: string, bot: TgPeerRef, startParam: string, options?: BusCallOptions) {
      return call('bot', 'start', accountId, { bot: stripPeer(bot), startParam }, options);
    },
    pressBotCallback(accountId: string, peer: TgPeerRef, messageId: number, data: string, options?: BusCallOptions) {
      return call('bot', 'pressCallback', accountId, { peer: stripPeer(peer), messageId, data }, options);
    },
    /**
     * 等待指定消息的下一次 UpdateEditMessage（搜索机器人静默改写消息时的事件驱动等待）。
     * timeoutMs 内收到则返回新 DTO，超时返回 null。
     */
    waitForMessageEdit(peerKey: TgPeerKey, messageId: number, timeoutMs = 4500): Promise<TgMessageDto | null> {
      return new Promise((resolve) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (settled) return;
          settled = true;
          unsub();
          resolve(null);
        }, timeoutMs);
        const unsub = mtprotoHub.subscribe((event) => {
          if (settled || event.type !== 'chatUpdates') return;
          for (const u of event.updates) {
            if (u.type === 'editMessage' && u.message.peerKey === peerKey && u.message.id === messageId) {
              settled = true;
              window.clearTimeout(timer);
              unsub();
              resolve(u.message);
              return;
            }
          }
        });
      });
    },
  },

  /** B9 VaultTransferBus：后台低优先级。 */
  vault: {
    forwardToVault(accountId: string, fromPeer: TgPeerRef, vaultPeer: TgPeerRef, messageIds: number[], topMsgId?: number, dropAuthor?: boolean, options?: BusCallOptions) {
      return call('vault', 'forward', accountId, { fromPeer: stripPeer(fromPeer), toPeer: stripPeer(vaultPeer), messageIds, topMsgId, dropAuthor }, options);
    },
    cloneNoForwardsToVault(accountId: string, fromPeer: TgPeerRef, vaultPeer: TgPeerRef, messageId: number, topMsgId?: number, options?: BusCallOptions) {
      return call('vault', 'cloneNoForwards', accountId, { fromPeer: stripPeer(fromPeer), toPeer: stripPeer(vaultPeer), messageId, topMsgId }, options);
    },
    ensureVaultForumTopics(accountId: string, vaultPeer: TgPeerRef, options?: BusCallOptions) {
      return call('vault', 'ensureTopics', accountId, { vaultPeer: stripPeer(vaultPeer) }, options);
    },
    syncBeaconCredentials(accountId: string, vaultPeer: TgPeerRef, topicMsgId: number | undefined, options?: BusCallOptions) {
      return call('vault', 'syncBeacon', accountId, { vaultPeer: stripPeer(vaultPeer), beaconTopicId: topicMsgId ?? 1 }, options);
    },
  },

  /** Worker 广播的实时更新批次（ChatReadBus 实时更新出口）。 */
  subscribeUpdates(listener: UpdatesListener): () => void {
    return mtprotoHub.subscribe((event) => {
      if (event.type === 'chatUpdates') listener(event.accountId, event.updates, event.state);
    });
  },

  /** 领域错误 → 中文提示。 */
  readError(error: unknown): string {
    const code = error instanceof TelegramBusRequestError ? error.code : '';
    const raw = `${code} ${error instanceof Error ? error.message : ''}`.toUpperCase();
    const matched = ERROR_MESSAGES.find(([pattern]) => raw.includes(pattern));
    if (matched) return matched[1];
    return error instanceof Error && error.message ? error.message : 'Telegram 请求失败，请稍后重试';
  },
};
