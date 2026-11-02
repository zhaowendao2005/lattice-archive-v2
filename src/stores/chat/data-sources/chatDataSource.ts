/**
 * [DATA SOURCE] 聊天内容接线器
 *
 * 唯一职责：把 chat 域的只读请求转交给本标签页的 MTProto Bridge（进而到本地 Telegram Worker），
 * 并把 Worker 广播的实时更新分发给 Store。聊天内容只在设备本地流转，绝不经过 Lattice 远端。
 */
import { mtprotoHub, TgChatRequestError } from '@/stores/telegram/data-sources/mtprotoBridge';
import type { TgChatUpdate, TgDialogCursor, TgDocumentLocation, TgMessageDto, TgPeerKey, TgPeerRef, TgPhotoLocation, TgPhotoSize, TgUpdatesState } from '../types';

type UpdatesListener = (accountId: string, updates: TgChatUpdate[], state?: TgUpdatesState) => void;

/** 完整文件下载的无进度超时：弱网下只要还在推进就不会被判超时。 */
const DOCUMENT_IDLE_TIMEOUT_MS = 30_000;

const ERROR_MESSAGES: [pattern: string, message: string][] = [
  ['TG_NOT_CONNECTED', 'Telegram 尚未连接，连接恢复后会自动加载'],
  ['TG_REQUEST_TIMEOUT', 'Telegram 请求超时，请稍后重试'],
  ['TG_CANCELED', '下载已取消'],
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

const stripCursor = (cursor: TgDialogCursor | undefined): TgDialogCursor | undefined =>
  cursor ? { offsetDate: cursor.offsetDate, offsetId: cursor.offsetId, offsetPeer: { ...cursor.offsetPeer } } : undefined;
const stripPeer = (peer: TgPeerRef): TgPeerRef => ({ type: peer.type, id: peer.id, accessHash: peer.accessHash });
const stripState = (state: TgUpdatesState | null): TgUpdatesState | null =>
  state ? { pts: state.pts, qts: state.qts, date: state.date, seq: state.seq } : null;

export const chatDataSource = {
  getDialogs(accountId: string, folderId: 0 | 1, cursor: TgDialogCursor | undefined, limit: number) {
    return mtprotoHub.bridge().requestChat(accountId, { method: 'getDialogs', folderId, cursor: stripCursor(cursor), limit });
  },

  getHistory(accountId: string, peer: TgPeerRef, offsetId: number, limit: number) {
    return mtprotoHub.bridge().requestChat(accountId, { method: 'getHistory', peer: stripPeer(peer), offsetId, limit });
  },

  getHistoryAround(accountId: string, peer: TgPeerRef, messageId: number, limit: number) {
    return mtprotoHub.bridge().requestChat(accountId, { method: 'getHistoryAround', peer: stripPeer(peer), messageId, limit });
  },

  syncFrom(accountId: string, state: TgUpdatesState | null) {
    return mtprotoHub.bridge().requestChat(accountId, { method: 'syncFrom', state: stripState(state) });
  },

  /** 下载会话或消息发送者头像（160×160 小图）。 */
  getAvatar(accountId: string, peer: TgPeerRef, photoId: string, dcId: number, containerPeer?: TgPeerRef, messageId?: number) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'getAvatar',
      peer: stripPeer(peer),
      photoId,
      dcId,
      containerPeer: containerPeer ? stripPeer(containerPeer) : undefined,
      messageId,
    });
  },

  /** 只拷贝定位字段：缩略图 data URL 等大字段不随请求往返 Worker。 */
  getPhoto(accountId: string, peer: TgPeerRef, messageId: number, photo: TgPhotoLocation, size: TgPhotoSize) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'getPhoto',
      peer: stripPeer(peer),
      messageId,
      photo: { id: photo.id, accessHash: photo.accessHash, fileReference: photo.fileReference, dcId: photo.dcId },
      size: stripSize(size),
    });
  },

  getDocumentThumb(accountId: string, peer: TgPeerRef, messageId: number, document: TgDocumentLocation, size: TgPhotoSize) {
    return mtprotoHub.bridge().requestChat(accountId, { method: 'getDocumentThumb', peer: stripPeer(peer), messageId, document: stripDocument(document), size: stripSize(size) });
  },

  /** 完整文件：进度经 onProgress 回调；30 s 内无任何进度视为超时；signal 中止时 Worker 在分片边界停止。 */
  getDocument(accountId: string, peer: TgPeerRef, messageId: number, document: TgDocumentLocation & { size: number; mimeType: string }, options: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal }) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'getDocument',
      peer: stripPeer(peer),
      messageId,
      document: stripDocument(document),
      size: document.size,
      mimeType: document.mimeType,
    }, { ...options, idleTimeoutMs: DOCUMENT_IDLE_TIMEOUT_MS });
  },

  /** 阶段 7：渐进式流播放的单个 512 KiB 对齐分片下载。 */
  getDocumentPart(
    accountId: string,
    peer: TgPeerRef,
    messageId: number,
    document: TgDocumentLocation & { size: number; mimeType: string },
    offset: number,
    limit: number,
    options?: { signal?: AbortSignal },
  ) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'getDocumentPart',
      peer: stripPeer(peer),
      messageId,
      document: stripDocument(document),
      offset,
      limit,
      size: document.size,
      mimeType: document.mimeType,
    }, { signal: options?.signal, idleTimeoutMs: DOCUMENT_IDLE_TIMEOUT_MS });
  },

  /** 阶段 8：归档 / 取消归档会话（folders.EditPeerFolders）。 */
  setDialogArchived(accountId: string, peer: TgPeerRef, archived: boolean) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'setDialogArchived',
      peer: stripPeer(peer),
      archived,
    });
  },

  /** 阶段 9：按公开 @username 解析会话。 */
  resolveUsername(accountId: string, username: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'resolveUsername',
      username,
    });
  },

  /** 阶段 9：加入公开频道或超级群组。 */
  joinChat(accountId: string, peer: TgPeerRef) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'joinChat',
      peer: stripPeer(peer),
    });
  },

  /** 阶段 9：退出频道、超级群组或基础群组。 */
  leaveChat(accountId: string, peer: TgPeerRef) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'leaveChat',
      peer: stripPeer(peer),
    });
  },

  /** 删除会话（针对用户间私聊，支持同时为对方删除 revoke: true；基础群组/频道转为退出）。 */
  deleteChat(accountId: string, peer: TgPeerRef, revoke = true) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'deleteChat',
      peer: stripPeer(peer),
      revoke,
    });
  },

  /** 发送文本消息（支持搜索群关键词输入、命令发送、回复指定消息）。 */
  sendMessage(accountId: string, peer: TgPeerRef, text: string, replyToMsgId?: number) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'sendMessage',
      peer: stripPeer(peer),
      text,
      replyToMsgId,
    });
  },

  /** 唤醒机器人并传递深链参数（messages.StartBot）。 */
  startBot(accountId: string, bot: TgPeerRef, startParam: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'startBot',
      bot: stripPeer(bot),
      startParam,
    });
  },

  /** 点击消息下方的 Callback 内联按钮（messages.GetBotCallbackAnswer）。 */
  pressBotCallback(accountId: string, peer: TgPeerRef, messageId: number, data: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'pressBotCallback',
      peer: stripPeer(peer),
      messageId,
      data,
    });
  },

  /** 检查私有邀请链接（messages.CheckChatInvite）。 */
  checkChatInvite(accountId: string, hash: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'checkChatInvite',
      hash,
    });
  },

  /** 通过私有邀请链接加入群组或频道（messages.ImportChatInvite）。 */
  importChatInvite(accountId: string, hash: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'importChatInvite',
      hash,
    });
  },

  /** 批量归档 / 取消归档多个会话（folders.EditPeerFolders 单次最多 100 个）。 */
  batchSetDialogsArchived(accountId: string, peers: TgPeerRef[], archived: boolean) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'batchSetDialogsArchived',
      peers: peers.map(stripPeer),
      archived,
    });
  },

  /** 批量巡检频道访问哈希状态（channels.GetChannels）。 */
  batchCheckChannels(accountId: string, peers: TgPeerRef[]) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'batchCheckChannels',
      channels: peers.map(stripPeer),
    });
  },

  /** 聚合搜索：单会话 messages.Search 或全局 messages.SearchGlobal。 */
  searchMessages(
    accountId: string,
    options: {
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
  ) {
    const rawFilter = options.filterType;
    const filter: 'all' | 'photo' | 'video' | 'document' | 'url' | 'music' | undefined =
      rawFilter === 'Photo' || rawFilter === 'photo_video'
        ? 'photo'
        : rawFilter === 'voice'
          ? 'music'
          : rawFilter;
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'searchMessages',
      peer: options.peer ? stripPeer(options.peer) : undefined,
      query: options.query,
      filter,
      minDate: options.minDate,
      maxDate: options.maxDate,
      offsetId: options.offsetId,
      offsetRate: options.offsetRate,
      offsetPeer: options.offsetPeer ? stripPeer(options.offsetPeer) : undefined,
      limit: options.limit,
    });
  },

  /** 零带宽服务端转发消息到共享私有备份群（messages.ForwardMessages）。 */
  forwardToVault(
    accountId: string,
    fromPeer: TgPeerRef,
    vaultPeer: TgPeerRef,
    messageIds: number[],
    topMsgId?: number,
    dropAuthor?: boolean,
  ) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'forwardToVault',
      fromPeer: stripPeer(fromPeer),
      toPeer: stripPeer(vaultPeer),
      messageIds,
      topMsgId,
      dropAuthor,
    });
  },

  /** 克隆防转发受限消息到共享私有备份群。 */
  cloneNoForwardsToVault(
    accountId: string,
    fromPeer: TgPeerRef,
    vaultPeer: TgPeerRef,
    messageId: number,
    topMsgId?: number,
  ) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'cloneNoForwardsToVault',
      fromPeer: stripPeer(fromPeer),
      toPeer: stripPeer(vaultPeer),
      messageId,
      topMsgId,
    });
  },

  /** 初始化共享私有备份群的 6 大默认 Forum Topics。 */
  ensureVaultForumTopics(accountId: string, vaultPeer: TgPeerRef) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'ensureVaultForumTopics',
      vaultPeer: stripPeer(vaultPeer),
    });
  },

  /** 将加密的临时会话池同步到备份群的 #02 会话凭据信标置顶消息。 */
  syncBeaconCredentials(accountId: string, vaultPeer: TgPeerRef, topicMsgId: number | undefined, _encryptedPayloadJson?: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'syncBeaconCredentials',
      vaultPeer: stripPeer(vaultPeer),
      beaconTopicId: topicMsgId ?? 1,
    });
  },

  /** 探测当前账号健康度与活跃授权设备列表（account.GetAuthorizations）。 */
  probeAccountHealth(accountId: string) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'probeAccountHealth',
    });
  },

  /** 6 步同机回环生成 PendingSlot 备用热槽位。 */
  spawnPendingSlot(
    accountId: string,
    apiId: number,
    apiHash: string,
    password2FA?: string,
    deviceFingerprint?: {
      deviceModel: string;
      systemVersion: string;
      appVersion: string;
      langCode: string;
      systemLangCode: string;
    },
  ) {
    return mtprotoHub.bridge().requestChat(accountId, {
      method: 'spawnPendingSlot',
      apiId,
      apiHash,
      twoFaPassword: password2FA,
      deviceFingerprint: deviceFingerprint ?? {
        deviceModel: 'Desktop',
        systemVersion: 'Mac OS X 14.5',
        appVersion: '5.12.3',
        langCode: 'zh-hans',
        systemLangCode: 'zh-CN',
      },
    });
  },

  subscribeUpdates(listener: UpdatesListener): () => void {
    return mtprotoHub.subscribe((event) => {
      if (event.type === 'chatUpdates') listener(event.accountId, event.updates, event.state);
    });
  },

  /**
   * 监听指定会话中某条消息的下一次 UpdateEditMessage 实时更新（供搜索机器人翻页事件驱动等待使用）。
   * 若在 timeoutMs 内收到该消息的编辑推送则立即返回新 TgMessageDto，超时则返回 null。
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

  /** 页面转入后台 / 关闭前回调，用于冷启动快照的落盘时机。 */
  onPageHidden(callback: () => void): () => void {
    const handleVisibility = () => { if (document.visibilityState === 'hidden') callback(); };
    document.addEventListener('visibilitychange', handleVisibility);
    window.addEventListener('pagehide', callback);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('pagehide', callback);
    };
  },

  readError(error: unknown): string {
    const code = error instanceof TgChatRequestError ? error.code : '';
    const raw = `${code} ${error instanceof Error ? error.message : ''}`.toUpperCase();
    const matched = ERROR_MESSAGES.find(([pattern]) => raw.includes(pattern));
    if (matched) return matched[1];
    return error instanceof Error && error.message ? error.message : 'Telegram 请求失败，请稍后重试';
  },
};
