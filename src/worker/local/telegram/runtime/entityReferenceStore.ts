/**
 * ============================================================================
 * EntityReferenceStore：file_reference 与 FILE_MIGRATE 目标 DC 缓存
 * ============================================================================
 * - file_reference 过期时按 peer + messageId 重新获取消息并刷新一次，多个并发分片共享同一次刷新；
 * - 新引用只驻留内存（上限 500 条），与用户上下文绑定：切换账户时必须 resetMediaState()；
 * - 封面、完整文件、流媒体三条总线共用本缓存，但各自使用不同的调度预算。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import type { TgPeerRef } from '../../chatProtocol';
import { resolveInputPeer } from './transportKernel';

export const MAX_REFERENCE_CACHE = 500; // 引用缓存上限（超过就淘汰最早的）

/** 媒体 ID → 最新 file_reference；file_reference 与用户上下文绑定，切换账户时必须清空。 */
export const freshReferences = new Map<string, Buffer>();

/** 进行中的引用刷新：多个并发分片遇到过期时共享同一次消息重拉。 */
export const refreshingReferences = new Map<string, Promise<Buffer>>();

/** 文档 ID → 发生过 FILE_MIGRATE 后的目标 DC。 */
export const migratedDcs = new Map<string, number>();

/** 切换账户 / 重新登录时清空全部媒体引用状态（引用与用户上下文绑定） */
export function resetMediaState() {
  freshReferences.clear();
  refreshingReferences.clear();
  migratedDcs.clear();
}

export function errorText(error: unknown) {
  return String((error as { errorMessage?: string })?.errorMessage ?? (error instanceof Error ? error.message : '')).toUpperCase();
}

/** file_reference 过期类错误（FILE_REFERENCE_EXPIRED / INVALID） */
export function isReferenceError(error: unknown) {
  return errorText(error).includes('FILE_REFERENCE');
}

/** 记录最新引用，超上限时删最早插入的（Map 保持插入顺序） */
export function rememberReference(id: string, reference: Buffer) {
  if (freshReferences.size >= MAX_REFERENCE_CACHE) {
    const oldest = freshReferences.keys().next().value;
    if (oldest !== undefined) freshReferences.delete(oldest);
  }
  freshReferences.set(id, reference);
}

/** 媒体已不可用（消息删除 / 媒体被替换）——不应当作网络问题重试 */
export function unavailable(): Error {
  return Object.assign(new Error('媒体已不可用（消息可能已被删除）'), { code: 'TG_MEDIA_UNAVAILABLE' });
}

export type MediaOwner = { kind: 'photo' | 'document'; id: string };

/** 在消息媒体中找到目标照片 / 文档（含视频封面与其他画质版本）。 */
export function findReference(media: Api.TypeMessageMedia | undefined, owner: MediaOwner): Buffer | undefined {
  if (owner.kind === 'photo') {
    const photos = [
      media instanceof Api.MessageMediaPhoto ? media.photo : undefined,
      media instanceof Api.MessageMediaDocument ? media.videoCover : undefined,
    ];
    const photo = photos.find((item): item is Api.Photo => item instanceof Api.Photo && item.id.toString() === owner.id);
    return photo?.fileReference;
  }
  if (!(media instanceof Api.MessageMediaDocument)) return undefined;
  const documents = [media.document, ...(media.altDocuments ?? [])];
  const document = documents.find((item): item is Api.Document => item instanceof Api.Document && item.id.toString() === owner.id);
  return document?.fileReference;
}

/** 重新拉取原消息以获得新的 file_reference；消息被删或媒体被替换时报告不可用。 */
export async function refreshReference(client: TelegramClient, peer: TgPeerRef, messageId: number, owner: MediaOwner): Promise<Buffer> {
  const input = await resolveInputPeer(client, peer);
  const ids = [new Api.InputMessageID({ id: messageId })];
  const result = input instanceof Api.InputPeerChannel
    ? await client.invoke(new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: input.channelId, accessHash: input.accessHash }), id: ids }))
    : await client.invoke(new Api.messages.GetMessages({ id: ids }));
  if (result instanceof Api.messages.MessagesNotModified) throw unavailable();
  const message = result.messages.find((item): item is Api.Message => item instanceof Api.Message && item.id === messageId);
  const reference = findReference(message?.media, owner);
  if (!reference) throw unavailable();
  rememberReference(owner.id, reference);
  return reference;
}

/**
 * 共享引用刷新：多个并发分片同时遇到过期时，只发一次 GetMessages。
 * finally 里删除 Promise，失败后下次还能重试。
 */
export function sharedRefresh(client: TelegramClient, peer: TgPeerRef, messageId: number, owner: MediaOwner): Promise<Buffer> {
  const existing = refreshingReferences.get(owner.id);
  if (existing) return existing;
  const task = refreshReference(client, peer, messageId, owner).finally(() => { refreshingReferences.delete(owner.id); });
  refreshingReferences.set(owner.id, task);
  return task;
}
