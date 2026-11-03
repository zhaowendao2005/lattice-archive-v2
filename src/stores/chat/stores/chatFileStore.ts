/**
 * chat 域附件文件下载（非视频类文档：普通文件 / 音频 / 语音）。
 *
 * - 下载：经 telegramBusClient.mediaAsset.getDocument 走本地 Worker 的完整文件通道（512 KiB 分片 × 4 路并行），字节进度写入 downloads；
 * - 保存：完成后交给 chatMediaLoader.saveBlob 触发浏览器保存；≤ 64 MB 的文件保留 URL，再次点击瞬时重新保存；
 * - 取消：下载中再次点击即中断（Worker 在分片边界停止）；
 * - 上限：整文件需驻留内存，超过 FILE_MEMORY_LIMIT 的文件提示改用官方客户端（后续可接 Service Worker 流式落盘）。
 */
import { defineStore } from 'pinia';
import { useChatStore } from './chatStore';
import { telegramBusClient } from '@/stores/telegram/data-sources/telegramBusClient';
import { chatMediaLoader } from '../data-sources/chatMediaLoader';
import type { FeedDocument } from '../types';
import { formatBytes, parseMediaTarget } from './chatModel';

const FILE_MEMORY_LIMIT = 1024 * 1024 * 1024;

/** 单个附件的下载状态；loaded / total 为字节进度。 */
export interface FileDownloadEntry {
  status: 'loading' | 'done' | 'error';
  loaded: number;
  total: number;
  error?: string;
}

/** 模块作用域：AbortController 不可序列化，不进入 Pinia state。 */
const controllers = new Map<string, AbortController>();
let generation = 0;

function resolveFile(target: string) {
  const parsed = parseMediaTarget(target);
  if (!parsed) return null;
  const message = useChatStore().windows[parsed.peerKey]?.messages.find((item) => item.id === parsed.messageId);
  const file = message?.media?.file;
  return file ? { peerKey: parsed.peerKey, messageId: parsed.messageId, file } : null;
}

export const useChatFileStore = defineStore('chatFile', {
  state: () => ({
    downloads: {} as Record<string, FileDownloadEntry>,
  }),

  getters: {
    /** 卡片副标题：下载中显示「已下载 / 总大小」，失败显示错误原因，其余显示文件大小。 */
    metaLabel: (state) => (file: FeedDocument): string => {
      const entry = state.downloads[file.key];
      if (entry?.status === 'loading') return `${formatBytes(entry.loaded)} / ${formatBytes(entry.total)}`;
      if (entry?.status === 'error') return entry.error ?? '下载失败，点击重试';
      return file.sizeLabel;
    },
    percent: (state) => (key: string): number => {
      const entry = state.downloads[key];
      return entry && entry.total > 0 ? Math.round((entry.loaded / entry.total) * 100) : 0;
    },
  },

  actions: {
    /** 附件卡片按钮：空闲 → 下载并保存；下载中 → 取消；已下载 → 直接再次保存。 */
    toggleDownload(file: FeedDocument) {
      const entry = this.downloads[file.key];
      if (entry?.status === 'loading') { this.cancel(file.key); return; }
      if (chatMediaLoader.resave(file.key, file.fileName)) return;
      void this.download(file);
    },

    async download(file: FeedDocument) {
      const chat = useChatStore();
      const resolved = resolveFile(file.target);
      const accountId = chat.accountId;
      const peer = resolved ? chat.peerRefOf(resolved.peerKey) : null;
      if (!resolved || !accountId || !peer) {
        this.downloads[file.key] = { status: 'error', loaded: 0, total: 0, error: '文件信息已失效，请刷新会话后重试' };
        return;
      }
      const { file: info, messageId } = resolved;
      if (info.size > FILE_MEMORY_LIMIT) {
        this.downloads[file.key] = { status: 'error', loaded: 0, total: info.size, error: '文件超过 1 GB，暂不支持在浏览器内下载' };
        return;
      }
      if (!chat.isOnline) {
        this.downloads[file.key] = { status: 'error', loaded: 0, total: info.size, error: 'Telegram 尚未连接，请稍后重试' };
        return;
      }
      const controller = new AbortController();
      const taskGeneration = generation;
      controllers.set(file.key, controller);
      this.downloads[file.key] = { status: 'loading', loaded: 0, total: info.size };
      const isCurrent = () => taskGeneration === generation && controllers.get(file.key) === controller;
      try {
        const result = await telegramBusClient.mediaAsset.getDocument(accountId, peer, messageId, info, {
          signal: controller.signal,
          onProgress: (loaded, total) => {
            if (isCurrent()) this.downloads[file.key] = { status: 'loading', loaded, total };
          },
        });
        if (!isCurrent()) return;
        chatMediaLoader.saveBlob(file.key, new Blob([result.bytes], { type: result.mimeType || info.mimeType }), file.fileName);
        this.downloads[file.key] = { status: 'done', loaded: info.size, total: info.size };
      } catch (error) {
        if (!isCurrent() || controller.signal.aborted) return;
        this.downloads[file.key] = { status: 'error', loaded: 0, total: info.size, error: telegramBusClient.readError(error) };
      } finally {
        if (controllers.get(file.key) === controller) controllers.delete(file.key);
      }
    },

    cancel(key: string) {
      controllers.get(key)?.abort();
      controllers.delete(key);
      delete this.downloads[key];
    },

    /** 切换账户 / 用户：中断全部在途下载并清空状态（保留的 Object URL 由 chatMediaLoader.reset 回收）。 */
    reset() {
      generation += 1;
      controllers.forEach((controller) => controller.abort());
      controllers.clear();
      this.downloads = {};
    },
  },
});
