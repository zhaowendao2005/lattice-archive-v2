/**
 * ============================================================================
 * Telegram / 媒体封面错误统一分桶与中文描述 (Error Buckets & Descriptions)
 * ============================================================================
 * 定位：纯函数基础设施，不依赖 Vue、GramJS 运行时或任何 Store。
 * 同时被 local Worker（MTProto 调用）与主线程（封面总线 / 搜索结果）复用，
 * 保证日志里的 `bucket`、`code`、`description` 在三端含义完全一致。
 *
 * 分桶目标：
 * 1. 让调试 API 可以按 `bucket` 聚合（例如统计 REF_EXPIRED 占比）；
 * 2. 日志中始终带可读中文描述，避免只看到裸错误码；
 * 3. 标记 retryable，供封面重试队列 / UI 提示复用。
 */

export type TgErrorBucket =
  | 'NO_ACCOUNT'      // 没有可用账号
  | 'OFFLINE'         // 账号不在线
  | 'NO_PEER'         // 缺少 peer 定位信息
  | 'NO_MEDIA'        // 消息本身没有可下载媒体（纯文本等）
  | 'NO_THUMB_SOURCE' // 有媒体但没有可用的缩略图档位
  | 'EMPTY_BYTES'     // 下载成功但字节为空
  | 'REF_EXPIRED'     // file_reference 过期 / 失效
  | 'FLOOD_WAIT'      // Telegram 限流
  | 'PERMISSION'      // 频道私有 / 无权限
  | 'NOT_FOUND'       // 消息 / 媒体 / peer 不存在
  | 'AUTH'            // 会话失效，需要重新登录
  | 'TIMEOUT'         // 请求超时
  | 'NETWORK'         // 连接中断 / 网络迁移
  | 'CANCELLED'       // 主动取消
  | 'BROKEN_IMAGE'    // 图片字节无法解码（坏 Data URL / MIME 不匹配）
  | 'STORAGE_QUOTA'   // 本地存储配额不足（localStorage / OPFS）
  | 'STORAGE_DENIED'  // 浏览器拒绝存储权限
  | 'UNKNOWN';        // 未归类

export interface TgErrorInfo {
  /** 归类分桶（日志与统计的主维度） */
  bucket: TgErrorBucket;
  /** 归一化后的错误码，例如 FILE_REFERENCE_EXPIRED / FLOOD_WAIT_32 / TG_REQUEST_TIMEOUT */
  code: string;
  /** 面向人的中文描述 */
  description: string;
  /** 是否值得自动重试 */
  retryable: boolean;
}

/** 前端可自行判定的「封面不可用」原因（不经过 Worker，也不会抛异常） */
export type CoverUnavailableReason =
  | 'NO_ACCOUNT'
  | 'OFFLINE'
  | 'NO_PEER'
  | 'NO_MEDIA'
  | 'NO_THUMB_SOURCE'
  | 'EMPTY_BYTES';

const BUCKET_META: Record<TgErrorBucket, { description: string; retryable: boolean }> = {
  NO_ACCOUNT: { description: '没有可用的 Telegram 账号，无法发起媒体请求', retryable: false },
  OFFLINE: { description: '账号当前不在线，无法发起媒体请求', retryable: true },
  NO_PEER: { description: '缺少会话 / 频道的定位信息（peer 或 accessHash）', retryable: false },
  NO_MEDIA: { description: '该消息不包含可下载媒体（纯文本消息等）', retryable: false },
  NO_THUMB_SOURCE: { description: '媒体存在但没有可用缩略图档位（thumbs 为空）', retryable: false },
  EMPTY_BYTES: { description: 'Telegram 返回了空字节，缩略图不可用', retryable: true },
  REF_EXPIRED: { description: 'file_reference 已过期或失效，需要刷新消息引用后重试', retryable: true },
  FLOOD_WAIT: { description: 'Telegram 触发限流（FLOOD_WAIT），需要等待后重试', retryable: true },
  PERMISSION: { description: '无权访问该频道 / 群组，或频道已转为私有', retryable: false },
  NOT_FOUND: { description: '消息、媒体或会话不存在，可能已被删除', retryable: false },
  AUTH: { description: '登录会话已失效，需要重新登录 Telegram', retryable: false },
  TIMEOUT: { description: 'Telegram 请求超时，可稍后重试', retryable: true },
  NETWORK: { description: '网络连接中断或正在迁移 DC，可稍后重试', retryable: true },
  CANCELLED: { description: '请求已被主动取消（切换搜索 / 离开页面）', retryable: false },
  BROKEN_IMAGE: { description: '图片字节无法解码，可能是损坏的 Data URL 或 MIME 与内容不匹配', retryable: false },
  STORAGE_QUOTA: { description: '本地存储配额不足，缩略图无法持久化（localStorage / OPFS）', retryable: false },
  STORAGE_DENIED: { description: '浏览器拒绝访问本地存储，缩略图无法持久化', retryable: false },
  UNKNOWN: { description: '未归类的错误，请结合 message 与 code 进一步排查', retryable: false },
};

const EXACT_CODES: Record<string, TgErrorBucket> = {
  TG_CANCELED: 'CANCELLED',
  AUTH_USER_CANCEL: 'CANCELLED',
  TG_REQUEST_TIMEOUT: 'TIMEOUT',
  TIMEOUT: 'TIMEOUT',
  CONNECTION_TIMEOUT: 'TIMEOUT',
  CONNECTION_NOT_INITED: 'NETWORK',
  DISCONNECTED: 'NETWORK',
  NETWORK_MIGRATE: 'NETWORK',
  FILE_MIGRATE: 'NETWORK',
  FILE_REFERENCE_EXPIRED: 'REF_EXPIRED',
  FILE_REFERENCE_INVALID: 'REF_EXPIRED',
  CHANNEL_PRIVATE: 'PERMISSION',
  CHAT_ADMIN_REQUIRED: 'PERMISSION',
  CHAT_WRITE_FORBIDDEN: 'PERMISSION',
  USER_BANNED_IN_CHANNEL: 'PERMISSION',
  CHANNEL_INVALID: 'NOT_FOUND',
  PEER_ID_INVALID: 'NOT_FOUND',
  MSG_ID_INVALID: 'NOT_FOUND',
  TG_MEDIA_UNAVAILABLE: 'NOT_FOUND',
  PHOTO_INVALID: 'NOT_FOUND',
  MEDIA_EMPTY: 'NOT_FOUND',
  MEDIA_INVALID: 'NOT_FOUND',
  DOCUMENT_INVALID: 'NOT_FOUND',
  AUTH_KEY_UNREGISTERED: 'AUTH',
  AUTH_KEY_DUPLICATED: 'AUTH',
  SESSION_REVOKED: 'AUTH',
  USER_DEACTIVATED: 'AUTH',
};

/** Telegram 错误消息里通常夹带 `CODE_99`，抽出最长的大写下划线 token。 */
const CODE_PATTERN = /\b(FLOOD_WAIT_\d+|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/;

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function extractCode(error: unknown): { code: string; message: string } {
  if (error === null || error === undefined) return { code: 'UNKNOWN', message: '' };
  if (typeof error === 'string') {
    const match = CODE_PATTERN.exec(error.toUpperCase());
    return { code: match?.[1] ?? 'UNKNOWN', message: error };
  }

  const record = error as {
    code?: unknown;
    errorMessage?: unknown;
    message?: unknown;
    seconds?: unknown;
  };
  const directCode = typeof record.code === 'string' ? normalizeCode(record.code) : '';
  const message =
    typeof record.message === 'string'
      ? record.message
      : typeof record.errorMessage === 'string'
        ? record.errorMessage
        : '';
  const rawMessage =
    typeof record.errorMessage === 'string' ? record.errorMessage : message;

  if (directCode && /^[A-Z][A-Z0-9_]+$/.test(directCode)) {
    return { code: directCode, message: rawMessage };
  }

  const match = CODE_PATTERN.exec(rawMessage.toUpperCase());
  if (match?.[1]) {
    // FLOOD_WAIT 的等待秒数在 gramjs 里也可能只放在 error.seconds
    if (match[1] === 'FLOOD_WAIT' && typeof record.seconds === 'number') {
      return { code: `FLOOD_WAIT_${record.seconds}`, message: rawMessage };
    }
    return { code: match[1], message: rawMessage };
  }

  return { code: 'UNKNOWN', message: rawMessage || (error instanceof Error ? error.message : String(error)) };
}

/** 把错误归一化成 { bucket, code, description, retryable }。 */
export function classifyTelegramError(error: unknown): TgErrorInfo {
  const domName =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name?: unknown }).name ?? '')
      : '';
  if (domName === 'QuotaExceededError') {
    const meta = BUCKET_META.STORAGE_QUOTA;
    return { bucket: 'STORAGE_QUOTA', code: 'QUOTA_EXCEEDED', ...meta };
  }
  if (domName === 'NotAllowedError' || domName === 'SecurityError') {
    const meta = BUCKET_META.STORAGE_DENIED;
    return { bucket: 'STORAGE_DENIED', code: domName.toUpperCase(), ...meta };
  }

  const { code, message } = extractCode(error);
  const bucket = code.startsWith('FLOOD_WAIT_') || code === 'FLOOD_WAIT' || code.startsWith('FLOOD_PREMIUM_WAIT_')
    ? 'FLOOD_WAIT'
    : code.startsWith('FILE_MIGRATE')
      ? 'NETWORK'
      : EXACT_CODES[code] ?? 'UNKNOWN';
  const meta = BUCKET_META[bucket];
  const waitSeconds = /(\d+)$/.exec(code)?.[1];
  const description =
    bucket === 'FLOOD_WAIT'
      ? `${BUCKET_META.FLOOD_WAIT.description}${waitSeconds ? `（${waitSeconds} 秒）` : ''}`
      : meta.description;
  return {
    bucket,
    code,
    description: message && bucket === 'UNKNOWN' ? `${description}：${message}` : description,
    retryable: meta.retryable,
  };
}

/** 仅按错误码分类（用于 Worker 已经只拿到 code 的场景）。 */
export function classifyTelegramCode(code: string): TgErrorInfo {
  return classifyTelegramError({ code });
}

/** 前端主动跳过的封面请求原因 → 与异常完全一致的分桶与描述。 */
export function describeCoverUnavailable(reason: CoverUnavailableReason): TgErrorInfo {
  return {
    bucket: reason,
    code: reason,
    description: BUCKET_META[reason].description,
    retryable: BUCKET_META[reason].retryable,
  };
}

/** 便于日志拼接的一行摘要。 */
export function formatTelegramError(error: unknown): string {
  const info = classifyTelegramError(error);
  return `[${info.bucket}] ${info.description}（code=${info.code}）`;
}