/**
 * 本地 Worker 内的媒体下载服务（阶段 4：图片；阶段 5：视频缩略图与完整视频文件）。
 *
 * - 只按需下载主线程指定的档位 / 文件，绝不为了占位而下载原图或原片；
 * - file_reference 过期时按 peer + messageId 重新获取消息并重试一次，新引用只驻留内存；
 * - 图片 / 缩略图与完整文件使用两套并发池：大文件下载不会挤占预览图，更不会挤占历史 / 会话 RPC；
 * - 完整文件以 512 KiB 分片多路并行写入预分配缓冲区，支持进度回调与分片边界取消；
 * - 下载失败不触发主连接重连，由主线程按退避策略重试。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { FileMigrateError } from 'telegram/errors';
import { returnBigInt } from 'telegram/Helpers';
import type { TgDocumentLocation, TgDocumentPart, TgMediaFile, TgPeerRef, TgPhotoLocation, TgPhotoSize } from '../chatProtocol';
import { peerInfo } from './converters';
import { resolveInputPeer } from './chatService';

const MAX_CONCURRENT_AVATARS = 2;      // 头像：优先级最高且量小，单独给 2 个名额
const MAX_CONCURRENT_DOWNLOADS = 4;    // 照片 / 缩略图：4 个并发够快又不至于打爆连接
/** 完整文件同时最多两个（查看器大文件 + 气泡内小 GIF / 圆形视频）；单个文件内部再按分片并行。 */
const MAX_CONCURRENT_FILES = 2;
/** 渐进式流播放分片池：独立于完整文件池，保证拖动进度条后的目标区间可立即并发拉取。 */
const MAX_CONCURRENT_STREAM_PARTS = 3;
/** upload.getFile 单次上限；偏移按此对齐即可满足「不跨 1 MiB 边界」约束。 */
export const PART_SIZE = 512 * 1024;
const PART_STREAMS = 4;          // 单个大文件内部并行度
const PART_TIMEOUT_RETRIES = 2;  // 单个分片超时重试次数
const MAX_REFERENCE_CACHE = 500; // 引用缓存上限（超过就淘汰最早的）

/** 媒体 ID → 最新 file_reference；file_reference 与用户上下文绑定，切换账户时必须清空。 */
const freshReferences = new Map<string, Buffer>();
/** 进行中的引用刷新：多个并发分片遇到过期时共享同一次消息重拉。 */
const refreshingReferences = new Map<string, Promise<Buffer>>();
/** 文档 ID → 发生过 FILE_MIGRATE 后的目标 DC。 */
const migratedDcs = new Map<string, number>();

/**
 * 手写的最小并发池（不引第三方库）：
 * acquire() 占一个名额（满了就排队），release() 释后唤醒下一个等待者。
 */
class Pool {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly limit: number;
  constructor(limit: number) { this.limit = limit; }
  async acquire() {
    if (this.active < this.limit) { this.active += 1; return; }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }
  release() {
    this.active -= 1;
    this.waiting.shift()?.();
  }
}

const avatarPool = new Pool(MAX_CONCURRENT_AVATARS);
const imagePool = new Pool(MAX_CONCURRENT_DOWNLOADS);
const filePool = new Pool(MAX_CONCURRENT_FILES);
const streamPool = new Pool(MAX_CONCURRENT_STREAM_PARTS);

/** 切换账户 / 重新登录时清空全部媒体引用状态（引用与用户上下文绑定） */
export function resetMediaState() {
  freshReferences.clear();
  refreshingReferences.clear();
  migratedDcs.clear();
}

/** 主线程发起的取消令牌：在分片边界检查，最迟一个分片往返后停止。 */
export interface CancelToken { canceled: boolean }

function errorText(error: unknown) {
  return String((error as { errorMessage?: string })?.errorMessage ?? (error instanceof Error ? error.message : '')).toUpperCase();
}

/** file_reference 过期类错误（FILE_REFERENCE_EXPIRED / INVALID） */
function isReferenceError(error: unknown) {
  return errorText(error).includes('FILE_REFERENCE');
}

/** 记录最新引用，超上限时删最早插入的（Map 保持插入顺序） */
function rememberReference(id: string, reference: Buffer) {
  if (freshReferences.size >= MAX_REFERENCE_CACHE) {
    const oldest = freshReferences.keys().next().value;
    if (oldest !== undefined) freshReferences.delete(oldest);
  }
  freshReferences.set(id, reference);
}

/** 媒体已不可用（消息删除 / 媒体被替换）——不应当作网络问题重试 */
function unavailable(): Error {
  return Object.assign(new Error('媒体已不可用（消息可能已被删除）'), { code: 'TG_MEDIA_UNAVAILABLE' });
}

/** 用户主动取消下载 */
function canceled(): Error {
  return Object.assign(new Error('下载已取消'), { code: 'TG_CANCELED' });
}

type MediaOwner = { kind: 'photo' | 'document'; id: string };

/** 在消息媒体中找到目标照片 / 文档（含视频封面与其他画质版本）。 */
function findReference(media: Api.TypeMessageMedia | undefined, owner: MediaOwner): Buffer | undefined {
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
async function refreshReference(client: TelegramClient, peer: TgPeerRef, messageId: number, owner: MediaOwner): Promise<Buffer> {
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

/** 把 Uint8Array 复制成独立的 ArrayBuffer，保证 transfer 后主线程能安全接手 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/** 小文件（照片档位 / 文档缩略图）：GramJS 顺序下载即可，引用过期时刷新一次。 */
async function downloadSmall(
  client: TelegramClient,
  peer: TgPeerRef,
  messageId: number,
  owner: MediaOwner,
  initialReference: string,
  dcId: number,
  bytes: number,
  locate: (reference: Buffer) => Api.TypeInputFileLocation,
): Promise<Buffer> {
  const download = async (reference: Buffer) => {
    const result = await client.downloadFile(locate(reference), { dcId, fileSize: bytes > 0 ? returnBigInt(bytes) : undefined });
    if (!result || typeof result === 'string' || result.byteLength === 0) throw unavailable();
    return result;
  };
  await imagePool.acquire();
  try {
    const reference = freshReferences.get(owner.id) ?? Buffer.from(initialReference, 'base64');
    try {
      return await download(reference);
    } catch (error) {
      if (!isReferenceError(error)) throw error;
      return await download(await refreshReference(client, peer, messageId, owner));
    }
  } finally {
    imagePool.release();
  }
}

/** 下载单张照片的指定档位（预览或原图） */
export async function downloadPhoto(client: TelegramClient, peer: TgPeerRef, messageId: number, photo: TgPhotoLocation, size: TgPhotoSize): Promise<TgMediaFile> {
  const bytes = await downloadSmall(client, peer, messageId, { kind: 'photo', id: photo.id }, photo.fileReference, photo.dcId, size.bytes, (reference) => new Api.InputPhotoFileLocation({
    id: returnBigInt(photo.id),
    accessHash: returnBigInt(photo.accessHash),
    fileReference: reference,
    thumbSize: size.type,
  }));
  return { bytes: toArrayBuffer(bytes), mimeType: 'image/jpeg' };
}

/** 下载文档缩略图（视频封面预览） */
export async function downloadDocumentThumb(client: TelegramClient, peer: TgPeerRef, messageId: number, document: TgDocumentLocation, size: TgPhotoSize): Promise<TgMediaFile> {
  const bytes = await downloadSmall(client, peer, messageId, { kind: 'document', id: document.id }, document.fileReference, document.dcId, size.bytes, (reference) => new Api.InputDocumentFileLocation({
    id: returnBigInt(document.id),
    accessHash: returnBigInt(document.accessHash),
    fileReference: reference,
    thumbSize: size.type,
  }));
  return { bytes: toArrayBuffer(bytes), mimeType: 'image/jpeg' };
}

/**
 * 会话或消息发送者头像下载（160×160 小图）：
 * - 使用独立并发池（上限 2），绝不挤占消息图片、视频缩略图或历史消息 RPC；
 * - 群消息中的 min 用户若无 access_hash，则使用 InputPeerUserFromMessage 定位。
 */
export async function downloadAvatar(
  client: TelegramClient,
  peer: TgPeerRef,
  photoId: string,
  dcId: number,
  containerPeer?: TgPeerRef,
  messageId?: number,
): Promise<TgMediaFile> {
  await avatarPool.acquire();
  try {
    let inputPeer: Api.TypeInputPeer;
    const knownHash = peer.accessHash ?? peerInfo(`${peer.type}-${peer.id}`)?.ref.accessHash;
    if (peer.type === 'user' && !knownHash && containerPeer && messageId) {
      inputPeer = new Api.InputPeerUserFromMessage({
        peer: await resolveInputPeer(client, containerPeer),
        msgId: messageId,
        userId: returnBigInt(peer.id),
      });
    } else {
      inputPeer = await resolveInputPeer(client, peer);
    }
    const location = new Api.InputPeerPhotoFileLocation({
      peer: inputPeer,
      photoId: returnBigInt(photoId),
      big: false,
    });
    const result = await client.downloadFile(location, { dcId });
    if (!result || typeof result === 'string' || result.byteLength === 0) throw unavailable();
    return { bytes: toArrayBuffer(result), mimeType: 'image/jpeg' };
  } finally {
    avatarPool.release();
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 共享引用刷新：多个并发分片同时遇到过期时，只发一次 GetMessages。
 * finally 里删除 Promise，失败后下次还能重试。
 */
function sharedRefresh(client: TelegramClient, peer: TgPeerRef, messageId: number, owner: MediaOwner): Promise<Buffer> {
  const existing = refreshingReferences.get(owner.id);
  if (existing) return existing;
  const task = refreshReference(client, peer, messageId, owner).finally(() => { refreshingReferences.delete(owner.id); });
  refreshingReferences.set(owner.id, task);
  return task;
}

/**
 * 拉取单个 512 KiB 对齐分片：处理跨 DC 迁移、共享 file_reference 刷新、超时重试与取消令牌。
 */
async function fetchAlignedPart(
  client: TelegramClient,
  peer: TgPeerRef,
  messageId: number,
  document: TgDocumentLocation,
  alignedOffset: number,
  token: CancelToken,
): Promise<Buffer> {
  const owner: MediaOwner = { kind: 'document', id: document.id };
  let reference = freshReferences.get(document.id) ?? Buffer.from(document.fileReference, 'base64');
  let refreshedOnce = false;
  let timeouts = 0;
  for (;;) {
    if (token.canceled) throw canceled();
    const usedReference = reference;
    const dcId = migratedDcs.get(document.id) ?? document.dcId;
    try {
      const sender = await client.getSender(dcId);
      const result = await client.invokeWithSender(new Api.upload.GetFile({
        location: new Api.InputDocumentFileLocation({
          id: returnBigInt(document.id),
          accessHash: returnBigInt(document.accessHash),
          fileReference: usedReference,
          thumbSize: '',
        }),
        offset: returnBigInt(alignedOffset),
        limit: PART_SIZE,
      }), sender);
      if (!(result instanceof Api.upload.File)) throw unavailable();
      return result.bytes;
    } catch (error) {
      if (token.canceled) throw canceled();
      if (error instanceof FileMigrateError) { migratedDcs.set(document.id, error.newDc); continue; }
      if (isReferenceError(error)) {
        const latest = freshReferences.get(document.id);
        if (latest && !latest.equals(usedReference)) { reference = latest; continue; }
        if (refreshedOnce) throw error;
        refreshedOnce = true;
        reference = await sharedRefresh(client, peer, messageId, owner);
        continue;
      }
      if (errorText(error).includes('TIMEOUT') && timeouts < PART_TIMEOUT_RETRIES) { timeouts += 1; await sleep(1_000); continue; }
      throw error;
    }
  }
}

/**
 * 渐进式流播放分片下载（阶段 7）：
 * - 底层向 Telegram 请求 512 KiB 对齐块，避免 OFFSET_INVALID / LIMIT_INVALID 或跨 1 MiB 边界；
 * - 若调用方传入非对齐区间，在对齐块内裁切返回目标子区间。
 */
export async function downloadDocumentPart(
  client: TelegramClient,
  peer: TgPeerRef,
  messageId: number,
  document: TgDocumentLocation,
  offset: number,
  limit: number,
  size: number,
  mimeType: string,
  token: CancelToken,
): Promise<TgDocumentPart> {
  if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit <= 0) throw unavailable();
  await streamPool.acquire();
  try {
    if (token.canceled) throw canceled();
    const alignedOffset = Math.floor(offset / PART_SIZE) * PART_SIZE;
    const relativeStart = offset - alignedOffset;
    const requestedLength = Math.min(limit, PART_SIZE - relativeStart);
    const bytes = await fetchAlignedPart(client, peer, messageId, document, alignedOffset, token);
    if (token.canceled) throw canceled();
    if (bytes.byteLength <= relativeStart) throw unavailable();
    const slice = bytes.subarray(relativeStart, Math.min(bytes.byteLength, relativeStart + requestedLength));
    const fullSize = bytes.byteLength < PART_SIZE ? alignedOffset + bytes.byteLength : size;
    return { bytes: toArrayBuffer(slice), mimeType, fullSize };
  } finally {
    streamPool.release();
  }
}

/**
 * 完整文件下载：PART_STREAMS 路并行领取 512 KiB 分片，直接写入预分配缓冲区（无二次拼接）。
 * - FILE_MIGRATE_X：切换到目标 DC 的导出连接；
 * - FILE_REFERENCE_*：多路共享同一次刷新；
 * - TIMEOUT：单分片最多重试 2 次；
 * - 取消：每个分片开始前与完成后检查令牌。
 */
export async function downloadDocument(
  client: TelegramClient,
  peer: TgPeerRef,
  messageId: number,
  document: TgDocumentLocation,
  size: number,
  mimeType: string,
  token: CancelToken,
  onProgress: (loaded: number, total: number) => void,
): Promise<TgMediaFile> {
  if (!Number.isFinite(size) || size <= 0) throw unavailable();
  await filePool.acquire();
  try {
    if (token.canceled) throw canceled();
    const output = new Uint8Array(size);
    let nextOffset = 0;
    let loaded = 0;
    let end = 0;

    const stream = async () => {
      while (nextOffset < size) {
        if (token.canceled) throw canceled();
        const offset = nextOffset;
        nextOffset += PART_SIZE;
        const bytes = await fetchAlignedPart(client, peer, messageId, document, offset, token);
        if (token.canceled) throw canceled();
        const usable = Math.min(bytes.byteLength, size - offset);
        if (usable > 0) {
          output.set(usable === bytes.byteLength ? bytes : bytes.subarray(0, usable), offset);
          loaded += usable;
          end = Math.max(end, offset + usable);
          onProgress(loaded, size);
        }
        // 服务端返回不足一个分片即到达文件末尾（文件实际比元数据小时，提前结束其余分片）。
        if (bytes.byteLength < PART_SIZE) nextOffset = Math.max(nextOffset, size);
      }
    };

    await Promise.all(Array.from({ length: Math.min(PART_STREAMS, Math.ceil(size / PART_SIZE)) }, stream));
    if (end === 0) throw unavailable();
    return { bytes: end === size ? output.buffer : output.slice(0, end).buffer, mimeType };
  } finally {
    filePool.release();
  }
}
