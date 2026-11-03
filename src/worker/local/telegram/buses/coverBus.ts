/**
 * ============================================================================
 * B4 CoverBus · 头像、照片档位、视频封面与文档缩略图
 * ============================================================================
 * - cover 子池服务 Chat 与搜索封面，搜索结果封面（origin=search）可使用保留槽位；头像走独立 avatar 子池；
 * - Tier-0 粗图随 DTO 内联，不占 RPC 槽；本总线只负责 Tier-1 细图；
 * - file_reference 过期时刷新一次后重试。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { returnBigInt } from 'telegram/Helpers';
import type { TgDocumentLocation, TgMediaFile, TgPeerRef, TgPhotoLocation, TgPhotoSize } from '../../chatProtocol';
import type { CoverOrigin } from '../contracts/buses';
import { peerInfo } from '../converters/converters';
import { resolveInputPeer } from '../runtime/transportKernel';
import { emitLocalSpan } from '../telemetry/localSpans';
import { classifyTelegramError } from '../../chat/telegramErrors';
import { freshReferences, isReferenceError, refreshReference, unavailable, type MediaOwner } from '../runtime/entityReferenceStore';
import { toArrayBuffer } from '../runtime/fileTransfer';
import type { AccountRequestScheduler, BusTaskOptions } from '../runtime/requestScheduler';

/** 小文件（照片档位 / 文档缩略图）：GramJS 顺序下载即可，引用过期时刷新一次。 */
export async function downloadSmall(
  scheduler: AccountRequestScheduler,
  options: BusTaskOptions,
  origin: CoverOrigin,
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
  return scheduler.run('cover', async (handle) => {
    const reference = freshReferences.get(owner.id) ?? Buffer.from(initialReference, 'base64');
    const counted = async (ref: Buffer) => { const bytes = await download(ref); handle.addBytes(bytes.byteLength); return bytes; };
    try {
      return await counted(reference);
    } catch (error) {
      if (!isReferenceError(error)) throw error;
      const info = classifyTelegramError(error);
      emitLocalSpan({
        domain: 'chat.media',
        action: 'reference_expired_retry',
        level: 'WARN',
        message: info.description,
        tags: {
          ownerKind: owner.kind,
          ownerId: owner.id,
          messageId,
          bucket: info.bucket,
          code: info.code,
        },
      });
      return await counted(await refreshReference(client, peer, messageId, owner));
    }
  }, { ...options, searchCover: origin === 'search', operation: `cover.${owner.kind}`, method: 'upload.GetFile', dcId });
}

/** 下载单张照片的指定档位（预览或原图） */
export async function downloadPhoto(scheduler: AccountRequestScheduler, options: BusTaskOptions, origin: CoverOrigin, client: TelegramClient, peer: TgPeerRef, messageId: number, photo: TgPhotoLocation, size: TgPhotoSize): Promise<TgMediaFile> {
  const startedAt = Date.now();
  try {
    const bytes = await downloadSmall(scheduler, options, origin, client, peer, messageId, { kind: 'photo', id: photo.id }, photo.fileReference, photo.dcId, size.bytes, (reference) => new Api.InputPhotoFileLocation({
      id: returnBigInt(photo.id),
      accessHash: returnBigInt(photo.accessHash),
      fileReference: reference,
      thumbSize: size.type,
    }));
    emitLocalSpan({
      domain: 'chat.media',
      action: 'photo_thumb_ok',
      level: 'DEBUG',
      durMs: Date.now() - startedAt,
      tags: {
        peerKey: `${peer.type}-${peer.id}`,
        messageId,
        photoId: photo.id,
        sizeType: size.type,
        expectedBytes: size.bytes,
        bytes: bytes.byteLength,
      },
    });
    return { bytes: toArrayBuffer(bytes), mimeType: 'image/jpeg' };
  } catch (error) {
    const info = classifyTelegramError(error);
    emitLocalSpan({
      domain: 'chat.media',
      action: 'photo_thumb_error',
      level: 'ERROR',
      durMs: Date.now() - startedAt,
      message: info.description,
      tags: {
        peerKey: `${peer.type}-${peer.id}`,
        messageId,
        photoId: photo.id,
        sizeType: size.type,
        bucket: info.bucket,
        code: info.code,
        retryable: info.retryable,
      },
    });
    throw error;
  }
}

/** 下载文档缩略图（视频封面预览） */
export async function downloadDocumentThumb(scheduler: AccountRequestScheduler, options: BusTaskOptions, origin: CoverOrigin, client: TelegramClient, peer: TgPeerRef, messageId: number, document: TgDocumentLocation, size: TgPhotoSize): Promise<TgMediaFile> {
  const startedAt = Date.now();
  try {
    const bytes = await downloadSmall(scheduler, options, origin, client, peer, messageId, { kind: 'document', id: document.id }, document.fileReference, document.dcId, size.bytes, (reference) => new Api.InputDocumentFileLocation({
      id: returnBigInt(document.id),
      accessHash: returnBigInt(document.accessHash),
      fileReference: reference,
      thumbSize: size.type,
    }));
    emitLocalSpan({
      domain: 'chat.media',
      action: 'document_thumb_ok',
      level: 'DEBUG',
      durMs: Date.now() - startedAt,
      tags: {
        peerKey: `${peer.type}-${peer.id}`,
        messageId,
        documentId: document.id,
        sizeType: size.type,
        expectedBytes: size.bytes,
        bytes: bytes.byteLength,
      },
    });
    return { bytes: toArrayBuffer(bytes), mimeType: 'image/jpeg' };
  } catch (error) {
    const info = classifyTelegramError(error);
    emitLocalSpan({
      domain: 'chat.media',
      action: 'document_thumb_error',
      level: 'ERROR',
      durMs: Date.now() - startedAt,
      message: info.description,
      tags: {
        peerKey: `${peer.type}-${peer.id}`,
        messageId,
        documentId: document.id,
        sizeType: size.type,
        bucket: info.bucket,
        code: info.code,
        retryable: info.retryable,
      },
    });
    throw error;
  }
}

/**
 * 会话或消息发送者头像下载（160×160 小图）：
 * - 使用独立并发池（上限 2），绝不挤占消息图片、视频缩略图或历史消息 RPC；
 * - 群消息中的 min 用户若无 access_hash，则使用 InputPeerUserFromMessage 定位。
 */
export async function downloadAvatar(
  scheduler: AccountRequestScheduler,
  options: BusTaskOptions,
  client: TelegramClient,
  peer: TgPeerRef,
  photoId: string,
  dcId: number,
  containerPeer?: TgPeerRef,
  messageId?: number,
): Promise<TgMediaFile> {
  const startedAt = Date.now();
  return scheduler.run('avatar', async (handle) => {
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
    try {
      const result = await client.downloadFile(location, { dcId });
      if (!result || typeof result === 'string' || result.byteLength === 0) throw unavailable();
      handle.addBytes(result.byteLength);
      emitLocalSpan({
        domain: 'chat.media',
        action: 'avatar_ok',
        level: 'DEBUG',
        durMs: Date.now() - startedAt,
        tags: {
          peerKey: `${peer.type}-${peer.id}`,
          photoId,
          dcId,
          bytes: result.byteLength,
        },
      });
      return { bytes: toArrayBuffer(result), mimeType: 'image/jpeg' };
    } catch (error) {
      const info = classifyTelegramError(error);
      emitLocalSpan({
        domain: 'chat.media',
        action: 'avatar_error',
        level: 'WARN',
        durMs: Date.now() - startedAt,
        message: info.description,
        tags: {
          peerKey: `${peer.type}-${peer.id}`,
          photoId,
          dcId,
          bucket: info.bucket,
          code: info.code,
          retryable: info.retryable,
        },
      });
      throw error;
    }
  }, { ...options, operation: 'avatar', method: 'upload.GetFile', dcId });
}
