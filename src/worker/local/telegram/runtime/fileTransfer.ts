/**
 * ============================================================================
 * 文件分片传输原语（upload.getFile 512 KiB 对齐分片）
 * ============================================================================
 * 处理跨 DC 迁移、共享 file_reference 刷新、分片超时重试与取消令牌；
 * 并发不在这里控制，由调用方（MediaAssetBus / StreamBus / VaultTransferBus）经 RequestScheduler 调度。
 */
import { Buffer } from 'buffer';
import type { TelegramClient } from 'telegram';
import { Api } from 'telegram/tl';
import { FileMigrateError } from 'telegram/errors';
import { returnBigInt } from 'telegram/Helpers';
import type { TgDocumentLocation, TgPeerRef } from '../../chatProtocol';
import { freshReferences, migratedDcs, isReferenceError, sharedRefresh, unavailable, errorText, type MediaOwner } from './entityReferenceStore';

/** upload.getFile 单次上限；偏移按此对齐即可满足「不跨 1 MiB 边界」约束。 */
export const PART_SIZE = 512 * 1024;

export const PART_TIMEOUT_RETRIES = 2;  // 单个分片超时重试次数

/** 主线程发起的取消令牌：在分片边界检查，排队中的分片经 signal 立即出队。 */
export interface CancelToken { readonly canceled: boolean; readonly signal: AbortSignal; cancel(): void }

export function createCancelToken(): CancelToken {
  const controller = new AbortController();
  return {
    get canceled() { return controller.signal.aborted; },
    signal: controller.signal,
    cancel() { controller.abort(); },
  };
}

/** 用户主动取消下载 */
export function canceled(): Error {
  return Object.assign(new Error('下载已取消'), { code: 'TG_CANCELED' });
}

/** 把 Uint8Array 复制成独立的 ArrayBuffer，保证 transfer 后主线程能安全接手 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * 拉取单个 512 KiB 对齐分片：处理跨 DC 迁移、共享 file_reference 刷新、超时重试与取消令牌。
 */
export async function fetchAlignedPart(
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
