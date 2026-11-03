/**
 * ============================================================================
 * B5 MediaAssetBus · 完整文件下载（照片原图 / 视频 / 文件 / 音频 / 语音）
 * ============================================================================
 * fullMedia 子池限制同时下载的文件数；文件内部按 mediaPart 配置路并行领取 512 KiB 分片，
 * 分片 RPC 计入媒体组与账号总预算；支持进度、排队出队与分片边界取消。
 */
import type { TelegramClient } from 'telegram';
import type { TgDocumentLocation, TgMediaFile, TgPeerRef } from '../../chatProtocol';
import { unavailable } from '../runtime/entityReferenceStore';
import { PART_SIZE, type CancelToken, canceled, fetchAlignedPart } from '../runtime/fileTransfer';
import { currentConcurrencyConfig, type AccountRequestScheduler, type BusTaskOptions } from '../runtime/requestScheduler';

/**
 * 完整文件下载：按 mediaPart 配置路并行领取 512 KiB 分片，直接写入预分配缓冲区（无二次拼接）。
 * - FILE_MIGRATE_X：切换到目标 DC 的导出连接；
 * - FILE_REFERENCE_*：多路共享同一次刷新；
 * - TIMEOUT：单分片最多重试 2 次；
 * - 取消：每个分片开始前与完成后检查令牌。
 */
export async function downloadDocument(
  scheduler: AccountRequestScheduler,
  options: BusTaskOptions,
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
  return scheduler.run('fullMedia', async (fileHandle) => {
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
        const bytes = await scheduler.run(
          'mediaPart',
          async (partHandle) => {
            const part = await fetchAlignedPart(client, peer, messageId, document, offset, token);
            partHandle.addBytes(part.byteLength);
            return part;
          },
          { ...options, signal: token.signal, operation: 'media.part', method: 'upload.GetFile', dcId: document.dcId },
        );
        if (token.canceled) throw canceled();
        const usable = Math.min(bytes.byteLength, size - offset);
        if (usable > 0) {
          output.set(usable === bytes.byteLength ? bytes : bytes.subarray(0, usable), offset);
          loaded += usable;
          end = Math.max(end, offset + usable);
          onProgress(loaded, size);
          fileHandle.progress(loaded, size);
        }
        // 服务端返回不足一个分片即到达文件末尾（文件实际比元数据小时，提前结束其余分片）。
        if (bytes.byteLength < PART_SIZE) nextOffset = Math.max(nextOffset, size);
      }
    };

    // 文件内并行度取用户配置的分片并发；实际 RPC 仍由 mediaPart 子池与账号媒体预算统一限流。
    const streams = Math.min(currentConcurrencyConfig().limits.mediaPart, Math.ceil(size / PART_SIZE));
    await Promise.all(Array.from({ length: streams }, stream));
    if (end === 0) throw unavailable();
    return { bytes: end === size ? output.buffer : output.slice(0, end).buffer, mimeType };
  }, { ...options, signal: token.signal, operation: 'media.file' });
}
