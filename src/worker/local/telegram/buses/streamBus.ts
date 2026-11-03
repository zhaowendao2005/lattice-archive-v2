/**
 * ============================================================================
 * B6 StreamBus · 渐进式视频播放分片
 * ============================================================================
 * 512 KiB 对齐读取，非对齐区间在块内裁切；streamPart 子池 interactive 优先级，
 * 播放器关闭 / seek / 切换会话时经 busCancel → AbortSignal 立即出队或在分片边界停止。
 */
import type { TelegramClient } from 'telegram';
import type { TgDocumentLocation, TgDocumentPart, TgPeerRef } from '../../chatProtocol';
import { unavailable } from '../runtime/entityReferenceStore';
import { PART_SIZE, type CancelToken, canceled, toArrayBuffer, fetchAlignedPart } from '../runtime/fileTransfer';
import type { AccountRequestScheduler, BusTaskOptions } from '../runtime/requestScheduler';

/**
 * 渐进式流播放分片下载（阶段 7）：
 * - 底层向 Telegram 请求 512 KiB 对齐块，避免 OFFSET_INVALID / LIMIT_INVALID 或跨 1 MiB 边界；
 * - 若调用方传入非对齐区间，在对齐块内裁切返回目标子区间。
 */
export async function downloadDocumentPart(
  scheduler: AccountRequestScheduler,
  options: BusTaskOptions,
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
  return scheduler.run('streamPart', async (handle) => {
    if (token.canceled) throw canceled();
    const alignedOffset = Math.floor(offset / PART_SIZE) * PART_SIZE;
    const relativeStart = offset - alignedOffset;
    const requestedLength = Math.min(limit, PART_SIZE - relativeStart);
    const bytes = await fetchAlignedPart(client, peer, messageId, document, alignedOffset, token);
    handle.addBytes(bytes.byteLength);
    if (token.canceled) throw canceled();
    if (bytes.byteLength <= relativeStart) throw unavailable();
    const slice = bytes.subarray(relativeStart, Math.min(bytes.byteLength, relativeStart + requestedLength));
    const fullSize = bytes.byteLength < PART_SIZE ? alignedOffset + bytes.byteLength : size;
    return { bytes: toArrayBuffer(slice), mimeType, fullSize };
  }, { ...options, signal: token.signal, operation: 'stream.part', method: 'upload.GetFile', dcId: document.dcId });
}
