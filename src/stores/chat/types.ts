/**
 * 聊天业务域类型：Worker DTO 的再导出 + Store 内部状态结构 + 视图模型。
 */
import type { TgDialogDto, TgMessageDto, TgPeerKey, TgUpdatesState } from '@/worker/local/chatProtocol';

export type { TgChatUpdate, TgDialogCursor, TgDialogDto, TgDocumentLocation, TgMediaFile, TgMessageDto, TgPeerKey, TgPeerRef, TgPhotoInfo, TgPhotoLocation, TgPhotoSize, TgUpdatesState, TgVideoInfo, TgVideoQuality } from '@/worker/local/chatProtocol';

/** 媒体加载状态：按「照片 ID + 尺寸档位」索引，Object URL 只在内存中存在。 */
export interface MediaEntry {
  status: 'queued' | 'loading' | 'ready' | 'error';
  url?: string;
  error?: string;
}

/** 完整视频文件的加载状态：按「画质文档 ID」索引；loaded / total 为字节进度。 */
export interface VideoEntry {
  status: 'queued' | 'loading' | 'ready' | 'error';
  loaded: number;
  total: number;
  url?: string;
  error?: string;
}

/** 单个播放位（slot）的纯数据状态，由 videoPlayback 数据源汇报。 */
export interface PlaybackState {
  attached: boolean;
  paused: boolean;
  ended: boolean;
  currentTime: number;
  duration: number;
  buffered: [number, number][];
  waiting: boolean;
  error: 'unsupported' | 'decode' | 'network' | null;
  pip: boolean;
  /** 浏览器拒绝了有声自动播放，需要用户再点一次。 */
  blocked: boolean;
}

/** 图片自动下载策略：按会话类型划分，关闭后需手动点击加载。 */
export interface AutoDownloadPrefs { private: boolean; group: boolean; channel: boolean }
/** GIF / 圆形视频在气泡内的静音自动播放开关。 */
export interface AutoplayPrefs { gif: boolean; round: boolean }
/** 播放器偏好：倍速、音量、静音与画质上限（0 = 自动）。 */
export interface PlayerPrefs { rate: number; volume: number; muted: boolean; maxHeight: number }

/**
 * 同步阶段（与 Telegram 连接状态分离）：
 * - no-account：本设备没有可用账户；
 * - cache：仅展示本地缓存，尚未与服务器校准；
 * - connecting：无缓存，等待 Telegram 连接；
 * - syncing：正在补差并刷新会话首页；
 * - live：已与服务器校准，实时更新生效；
 * - offline：连接中断或同步失败，界面数据可能过期。
 */
export type ChatSyncPhase = 'no-account' | 'cache' | 'connecting' | 'syncing' | 'live' | 'offline';

/**
 * 单个会话的消息窗口：始终是「以最新消息为右端」的连续区间，向上分页扩展。
 * continuous=false 表示窗口与服务器最新状态之间可能有缺口，实时更新不能直接插入，打开时需重新拉取最新页。
 */
export interface MessageWindow {
  messages: TgMessageDto[];
  hasOlder: boolean;
  continuous: boolean;
  /** 本次运行中是否已从服务器刷新过最新页。 */
  fresh: boolean;
  isLoadingLatest: boolean;
  isLoadingOlder: boolean;
  error: string | null;
  /** 窗口被整体替换时递增，用于丢弃替换前发出的翻页响应。 */
  epoch: number;
}

/** 加密落盘的冷启动快照：裁剪后的列表与最近会话，不是完整历史。v2：消息媒体携带视频定位信息。 */
export interface ChatCacheSnapshot {
  version: 2;
  ownerId: string;
  accountId: string;
  savedAt: number;
  updatesState: TgUpdatesState | null;
  dialogs: TgDialogDto[];
  pinnedOrder: TgPeerKey[];
  windows: Record<TgPeerKey, { messages: TgMessageDto[]; hasOlder: boolean }>;
  recentChatKeys: TgPeerKey[];
  activeChatKey: TgPeerKey | null;
  viewportAnchors: Record<TgPeerKey, number>;
}

export interface SessionListItem {
  key: TgPeerKey;
  title: string;
  initials: string;
  preview: string;
  timeLabel: string;
  unreadCount: number;
  unreadMark: boolean;
  muted: boolean;
  pinned: boolean;
  kindLabel: string;
}

export interface FeedDayItem { type: 'day'; key: string; label: string }
export interface FeedServiceItem { type: 'service'; key: string; text: string }
/** 消息气泡内的一个视觉媒体（照片 / 视频 / GIF）：只含静态展示信息，加载状态由视图按 previewKey / target 直接读取媒体 Store。 */
export interface FeedPhoto {
  kind: 'photo' | 'video' | 'gif';
  /** `${peerKey}:${messageId}`，用于可见性观察与查看器定位。 */
  target: string;
  messageId: number;
  /** 预览图（照片预览档 / 视频缩略图）的媒体键；视频没有缩略图档位时为空串。 */
  previewKey: string;
  thumb?: string;
  spoiler: boolean;
  /** CSS aspect-ratio，已夹紧极端长宽比。 */
  aspectRatio: number;
  /** 单图展示宽度（px），下载前即可锁定气泡尺寸。 */
  width: number;
  /** 相册网格中占据的列数（首张横跨两列的布局）。 */
  span: 1 | 2;
  /** 视频时长，如 1:23。 */
  durationLabel?: string;
  /** 视频文件大小，如 12.4 MB。 */
  sizeLabel?: string;
}
export type FeedVisual = FeedPhoto;
/** 以文件方式发送的视频：附件卡片。 */
export interface FeedVideoFile { target: string; fileName: string; metaLabel: string; thumb?: string; previewKey: string; playable: boolean }
/** 圆形视频消息。 */
export interface FeedRound { target: string; previewKey: string; thumb?: string; durationLabel: string; duration: number }
export interface FeedMessageItem {
  type: 'message';
  key: string;
  id: number;
  out: boolean;
  text: string;
  mediaLabel?: string;
  /** 单图或相册（同一 groupedId 的连续照片 / 视频合并为一个气泡）。 */
  photos?: FeedPhoto[];
  videoFile?: FeedVideoFile;
  round?: FeedRound;
  /** 相册包含的全部消息 ID，供阅读锚点定位。 */
  albumIds?: number[];
  /** 相册网格列数（2 或 3）。 */
  albumColumns?: 2 | 3;
  senderName?: string;
  senderInitials: string;
  /** 群组会话：入站消息左侧保留头像列。 */
  inGroup: boolean;
  /** 群组中同一发送者连续消息只在首条展示头像与昵称。 */
  showSender: boolean;
  timeLabel: string;
  edited: boolean;
  forwardedFrom?: string;
  replyToId?: number;
  readState?: 'sent' | 'read';
}
export type FeedItem = FeedDayItem | FeedServiceItem | FeedMessageItem;
