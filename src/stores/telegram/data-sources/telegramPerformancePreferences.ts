/**
 * [DATA SOURCE] Telegram 并发配额本机偏好（localStorage）
 *
 * 薄桥接：只负责读写与归一化（校验逻辑在 worker/local 契约中，与 Worker 调度器共用）。
 * - 读取失败 / 内容损坏 / 隐私模式一律回退默认均衡预设，不阻断启动；
 * - 内存中保留最近一次读写结果，供 Bridge 初始化 Worker、封面总线与媒体加载器读取当前上限。
 */
import {
  DEFAULT_TELEGRAM_CONCURRENCY,
  normalizeTelegramConcurrency,
  type TelegramConcurrencyConfig,
} from '@/worker/local/telegram/contracts/concurrency';

const STORAGE_KEY = 'lattice.telegram.concurrency.v1';

let cached: TelegramConcurrencyConfig | null = null;
const listeners = new Set<(config: TelegramConcurrencyConfig) => void>();

function load(): TelegramConcurrencyConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeTelegramConcurrency(raw ? JSON.parse(raw) : DEFAULT_TELEGRAM_CONCURRENCY);
  } catch {
    return normalizeTelegramConcurrency(DEFAULT_TELEGRAM_CONCURRENCY);
  }
}

// 其他标签页修改设置后同步本页限流器（Worker 只在主标签页，由 setConcurrency 命令统一下发）。
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    cached = load();
    const next = cached;
    listeners.forEach((listener) => listener(next));
  });
}

export const telegramPerformancePreferences = {
  /** 当前持久化配置（已归一化）。 */
  read(): TelegramConcurrencyConfig {
    if (!cached) cached = load();
    return cached;
  },

  /** 归一化后落盘并通知主线程限流器；返回实际保存的配置。 */
  write(config: TelegramConcurrencyConfig): TelegramConcurrencyConfig {
    const normalized = normalizeTelegramConcurrency(config);
    cached = normalized;
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* 存储不可用时仅本次运行生效 */ }
    listeners.forEach((listener) => listener(normalized));
    return normalized;
  },

  /** 主线程限流器（封面总线 / 媒体加载器）订阅配置变化。 */
  subscribe(listener: (config: TelegramConcurrencyConfig) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};
