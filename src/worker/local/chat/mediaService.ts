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
import type { TgDocumentLocation, TgMediaFile, TgPeerRef, TgPhotoLocation, TgPhotoSize } from '../chatProtocol';
import { resolveInputPeer } from './chatService';

const MAX_CONCURRENT_DOWNLOADS = 4;
/** 完整文件同时最多两个（查看器大文件 + 气泡内小 GIF / 圆形视频）；单个文件内部再按分片并行。 */
const MAX_CONCURRENT_FILES = 2;
/** upload.getFile 单次上限；偏移按此对齐即可满足「不跨 1 MiB 边界」约束。 */
const PART_SIZE = 512 * 1024;
const PART_STREAMS = 4;
const PART_TIMEOUT_RETRIES = 2;
const MAX_REFERENCE_CACHE = 500;

/** 媒体 ID → 最新 file_reference；file_reference 与用户上下文绑定，切换账户时必须清空。 */
const freshReferences = new Map<string, Buffer>();

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

const imagePool = new Pool(MAX_CONCURRENT_DOWNLOADS);
const filePool = new Pool(MAX_CONCURRENT_FILES);

export function resetMediaState() {
  freshReferences.clear();
}

/** 主线程发起的取消令牌：在分片边界检查，最迟一个分片往返后停止。 */
export interface CancelToken { canceled: boolean }

function errorText(error: unknown) {
  return String((error as { errorMessage?: string })?.errorMessage ?? (error instanceof Error ? error.message : '')).toUpperCase();
}

function isReferenceError(error: unknown) {
  return errorText(error).includes('FILE_REFERENCE');
}

function rememberReference(id: string, reference: Buffer) {
  if (freshReferences.size >= MAX_REFERENCE_CACHE) {
    const oldest = freshReferences.keys().next().value;
    if (oldest !== undefined) freshReferences.delete(oldest);
  }
  freshReferences.set(id, reference);
}

function unavailable(): Error {
  return Object.assign(new Error('媒体已不可用（消息可能已被删除）'), { code: 'TG_MEDIA_UNAVAILABLE' });
}

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

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
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

export async function downloadPhoto(client: TelegramClient, peer: TgPeerRef, messageId: number, photo: TgPhotoLocation, size: TgPhotoSize): Promise<TgMediaFile> {
  const bytes = await downloadSmall(client, peer, messageId, { kind: 'photo', id: photo.id }, photo.fileReference, photo.dcId, size.bytes, (reference) => new Api.InputPhotoFileLocation({
    id: returnBigInt(photo.id),
    accessHash: returnBigInt(photo.accessHash),
    fileReference: reference,
    thumbSize: size.type,
  }));
  return { bytes: toArrayBuffer(bytes), mimeType: 'image/jpeg' };
}

export async function downloadDocumentThumb(client: TelegramClient, peer: TgPeerRef, messageId: number, document: TgDocumentLocation, size: TgPhotoSize): Promise<TgMediaFile> {
  const bytes = await downloadSmall(client, peer, messageId, { kind: 'document', id: document.id }, document.fileReference, document.dcId, size.bytes, (reference) => new Api.InputDocumentFileLocation({
    id: returnBigInt(document.id),
    accessHash: returnBigInt(document.accessHash),
    fileReference: reference,
    thumbSize: size.type,
  }));
  return { bytes: toArrayBuffer(bytes), mimeType: 'image/jpeg' };
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

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
    const owner: MediaOwner = { kind: 'document', id: document.id };
    const output = new Uint8Array(size);
    let reference = freshReferences.get(document.id) ?? Buffer.from(document.fileReference, 'base64');
    let refreshing: Promise<Buffer> | null = null;
    let refreshed = false;
    let dcId = document.dcId;
    let nextOffset = 0;
    let loaded = 0;
    let end = 0;

    const fetchPart = async (offset: number): Promise<Buffer> => {
      let timeouts = 0;
      for (;;) {
        if (token.canceled) throw canceled();
        const usedReference = reference;
        try {
          const sender = await client.getSender(dcId);
          const result = await client.invokeWithSender(new Api.upload.GetFile({
            location: new Api.InputDocumentFileLocation({ id: returnBigInt(document.id), accessHash: returnBigInt(document.accessHash), fileReference: usedReference, thumbSize: '' }),
            offset: returnBigInt(offset),
            limit: PART_SIZE,
          }), sender);
          if (!(result instanceof Api.upload.File)) throw unavailable();
          return result.bytes;
        } catch (error) {
          if (token.canceled) throw canceled();
          if (error instanceof FileMigrateError) { dcId = error.newDc; continue; }
          if (isReferenceError(error)) {
            // 其他分片已经刷新过引用：直接用新引用重试。
            if (reference !== usedReference) continue;
            if (refreshed && !refreshing) throw error;
            refreshing ??= refreshReference(client, peer, messageId, owner).finally(() => { refreshing = null; });
            refreshed = true;
            reference = await refreshing;
            continue;
          }
          if (errorText(error).includes('TIMEOUT') && timeouts < PART_TIMEOUT_RETRIES) { timeouts += 1; await sleep(1_000); continue; }
          throw error;
        }
      }
    };

    const stream = async () => {
      while (nextOffset < size) {
        if (token.canceled) throw canceled();
        const offset = nextOffset;
        nextOffset += PART_SIZE;
        const bytes = await fetchPart(offset);
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
