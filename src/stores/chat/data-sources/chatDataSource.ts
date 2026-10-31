/**
 * [DATA SOURCE] 聊天内容接线器
 *
 * 唯一职责：把 chat 域的只读请求转交给本标签页的 MTProto Bridge（进而到本地 Telegram Worker），
 * 并把 Worker 广播的实时更新分发给 Store。聊天内容只在设备本地流转，绝不经过 Lattice 远端。
 */
import { mtprotoHub, TgChatRequestError } from '@/stores/telegram/data-sources/mtprotoBridge';
import type { TgChatUpdate, TgDialogCursor, TgDocumentLocation, TgPeerRef, TgPhotoLocation, TgPhotoSize, TgUpdatesState } from '../types';

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

  subscribeUpdates(listener: UpdatesListener): () => void {
    return mtprotoHub.subscribe((event) => {
      if (event.type === 'chatUpdates') listener(event.accountId, event.updates, event.state);
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
