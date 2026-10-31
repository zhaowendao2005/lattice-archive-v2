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
  ['FLOOD_WAIT', '请求过于频繁，Telegram 要求稍后再试'],
  ['CHANNEL_PRIVATE', '无权访问该会话（可能已退出或被移出）'],
  ['CHAT_FORBIDDEN', '无权访问该会话'],
  ['PEER_ID_INVALID', '无法识别该会话，请从会话列表重新打开'],
  ['CHANNEL_INVALID', '无法识别该频道，请从会话列表重新打开'],
  ['AUTH_KEY', 'Telegram 授权已失效，请在设置中重新添加本设备'],
  ['TG_MEDIA_UNAVAILABLE', '媒体已不可用（消息可能已被删除）'],
  ['FILE_REFERENCE', '媒体引用已过期，请重试'],
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

  syncFrom(accountId: string, state: TgUpdatesState | null) {
    return mtprotoHub.bridge().requestChat(accountId, { method: 'syncFrom', state: stripState(state) });
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
