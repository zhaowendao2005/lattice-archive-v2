/**
 * 聊天内容协议：本地 Telegram Worker 与主线程之间传输的纯数据结构。
 *
 * 约束：
 * 1. 全部字段必须可被结构化克隆（不得出现 BigInteger / TL 实例 / 函数）；
 * 2. Telegram 64 位 ID、access_hash、grouped_id 一律使用十进制字符串，避免 JS 精度丢失；
 * 3. 消息 ID 是 int32，可安全使用 number；
 * 4. 这些数据只在设备本地流转与缓存，绝不上传 Lattice 远端。
 */

export type TgPeerType = 'user' | 'chat' | 'channel';

/** 构造 InputPeer 所需的最小引用；access_hash 缺失时 Worker 会尝试从实体缓存解析。 */
export interface TgPeerRef { type: TgPeerType; id: string; accessHash?: string }

/** 会话主键，形如 `user-123` / `chat-456` / `channel-789`，同时用作路由参数。 */
export type TgPeerKey = string;

export type TgChatKind = 'self' | 'user' | 'bot' | 'group' | 'supergroup' | 'channel';

export type TgMediaKind = 'photo' | 'video' | 'round' | 'gif' | 'voice' | 'audio' | 'sticker' | 'file' | 'location' | 'contact' | 'poll' | 'other';

/** 照片的单个尺寸档位：type 即 Telegram PhotoSize.type（m / x / y / w 等），bytes 为服务端报告的文件大小。 */
export interface TgPhotoSize { type: string; width: number; height: number; bytes: number }

/** 下载照片所需的最小定位信息；file_reference 会过期，Worker 负责按消息重新获取。 */
export interface TgPhotoLocation {
  id: string;
  accessHash: string;
  /** base64 编码的 file_reference。 */
  fileReference: string;
  dcId: number;
}

export interface TgPhotoInfo extends TgPhotoLocation {
  /** 原图宽高，用于在下载前锁定占位尺寸，避免图片加载后撑开布局打乱滚动锚点。 */
  width: number;
  height: number;
  /** 由 stripped thumb 还原的极小 JPEG data URL：随消息下发，无需网络即可显示模糊占位。 */
  thumb?: string;
  /** 消息气泡内显示的预览档位（不超过 800px）；缺省时直接使用 full。 */
  preview?: TgPhotoSize;
  /** 查看器使用的最大档位。 */
  full: TgPhotoSize;
  /** 防剧透遮罩：需要用户点击后才显示。 */
  spoiler?: boolean;
}

/** 文档（视频 / 文件）定位信息；file_reference 过期时由 Worker 按消息重新获取。 */
export interface TgDocumentLocation {
  id: string;
  accessHash: string;
  /** base64 编码的 file_reference。 */
  fileReference: string;
  dcId: number;
}

/** 同一视频的一个画质版本（原片或 altDocuments 中的转码版本）。 */
export interface TgVideoQuality extends TgDocumentLocation {
  width: number;
  height: number;
  /** 字节数（Telegram long，4 GB 以内可安全转 number）。 */
  size: number;
  mimeType: string;
  /** DocumentAttributeVideo.video_codec，如 h264 / h265 / av1；缺省视为 h264。 */
  codec?: string;
  original?: true;
}

export interface TgVideoInfo extends TgDocumentLocation {
  mimeType: string;
  size: number;
  /** 秒，可能带小数。 */
  duration: number;
  width: number;
  height: number;
  supportsStreaming: boolean;
  noSound: boolean;
  codec?: string;
  fileName?: string;
  /** 由 stripped thumb 还原的模糊 JPEG data URL。 */
  thumb?: string;
  /** 文档缩略图档位（通常为 m / 320px），经 InputDocumentFileLocation.thumbSize 下载。 */
  preview?: TgPhotoSize;
  /** 视频封面（videoCover）：存在时优先作为预览图来源。 */
  cover?: TgPhotoInfo;
  spoiler?: boolean;
  /** 以「文件」方式发送的视频：按附件卡片展示，点击进入播放器，不参与相册与查看器翻页。 */
  asFile?: true;
  /** 可选画质（含原片，按高度降序）；只有一项时不显示画质菜单。 */
  qualities: TgVideoQuality[];
  /** 分享链接携带的起播时间（videoTimestamp）。 */
  startAt?: number;
}

export interface TgMessageMedia { kind: TgMediaKind; label: string; photo?: TgPhotoInfo; video?: TgVideoInfo }

/** 媒体文件字节：Worker 以 Transferable 移交，主线程负责生成 Object URL 与本地缓存。 */
export interface TgMediaFile { bytes: ArrayBuffer; mimeType: string }

export interface TgMessageDto {
  id: number;
  peerKey: TgPeerKey;
  /** Unix 秒。 */
  date: number;
  editDate?: number;
  out: boolean;
  /** 普通消息 / 系统事件（入群、置顶等）。 */
  kind: 'message' | 'service';
  senderKey?: TgPeerKey;
  senderName?: string;
  text: string;
  media?: TgMessageMedia;
  replyToId?: number;
  groupedId?: string;
  forwardedFrom?: string;
  views?: number;
}

export interface TgDialogDto {
  key: TgPeerKey;
  peer: TgPeerRef;
  kind: TgChatKind;
  title: string;
  pinned: boolean;
  folderId: number;
  muted: boolean;
  unreadCount: number;
  unreadMentions: number;
  unreadMark: boolean;
  readInboxMaxId: number;
  readOutboxMaxId: number;
  topMessageId: number;
  /** 最后一条消息的 Unix 秒，用于排序。 */
  date: number;
  lastMessage?: TgMessageDto;
}

/** 会话列表分页游标：top message 日期 + ID + peer，不能用数组下标翻页。 */
export interface TgDialogCursor { offsetDate: number; offsetId: number; offsetPeer: TgPeerRef }

export interface TgDialogPage {
  /** 仅首页包含：服务器返回的置顶顺序。 */
  pinnedKeys?: TgPeerKey[];
  dialogs: TgDialogDto[];
  nextCursor?: TgDialogCursor;
  hasMore: boolean;
  /** Telegram 报告的活动列表会话总数（DialogsSlice.count）；完整返回时等于本页数量。 */
  totalCount: number;
  /** 仅首页包含：活动列表中是否存在「已归档」文件夹入口（归档会话不在活动列表内）。 */
  hasArchive?: boolean;
}

export interface TgHistoryPage {
  /** 按 ID 升序。 */
  messages: TgMessageDto[];
  /** 是否还有更早的历史可以继续向上翻。 */
  hasOlder: boolean;
}

/** Telegram 公共更新序列状态（不含频道各自的 pts）。 */
export interface TgUpdatesState { pts: number; qts: number; date: number; seq: number }

export type TgChatUpdate =
  | { type: 'newMessage'; message: TgMessageDto }
  | { type: 'editMessage'; message: TgMessageDto }
  /** peerKey 缺省表示公共消息盒（私聊 / 基础群），ID 在其中全局唯一。 */
  | { type: 'deleteMessages'; peerKey?: TgPeerKey; ids: number[] }
  | { type: 'readInbox'; peerKey: TgPeerKey; maxId: number; stillUnreadCount?: number }
  | { type: 'readOutbox'; peerKey: TgPeerKey; maxId: number }
  /** 置顶 / 文件夹等列表结构变化，需要重新拉取会话首页。 */
  | { type: 'dialogsChanged' }
  /** 频道更新过多被服务端截断，该频道的本地消息窗口不再连续。 */
  | { type: 'channelTooLong'; peerKey: TgPeerKey }
  /** 公共 pts 出现缺口或连接重建，需要通过 getDifference 补差。 */
  | { type: 'gap' };

/**
 * 补差结果：difference 表示 updates 覆盖了 state 以来的全部公共变化；
 * reset 表示差异过大或无本地状态，调用方必须以服务器为准重建窗口。
 */
export interface TgSyncResult { kind: 'difference' | 'reset'; state: TgUpdatesState; updates: TgChatUpdate[] }

export type TgChatRequest =
  | { method: 'getDialogs'; folderId?: 0 | 1; cursor?: TgDialogCursor; limit: number }
  | { method: 'getHistory'; peer: TgPeerRef; offsetId: number; limit: number }
  | { method: 'syncFrom'; state: TgUpdatesState | null }
  /** 下载照片的某个尺寸档位；peer + messageId 用于 file_reference 过期时重新获取消息。 */
  | { method: 'getPhoto'; peer: TgPeerRef; messageId: number; photo: TgPhotoLocation; size: TgPhotoSize }
  /** 下载文档（视频）缩略图档位。 */
  | { method: 'getDocumentThumb'; peer: TgPeerRef; messageId: number; document: TgDocumentLocation; size: TgPhotoSize }
  /** 下载完整文件：Worker 以 chatProgress 汇报进度，可被 chatCancel 中断。 */
  | { method: 'getDocument'; peer: TgPeerRef; messageId: number; document: TgDocumentLocation; size: number; mimeType: string };

export interface TgChatResponseMap {
  getDialogs: TgDialogPage;
  getHistory: TgHistoryPage;
  syncFrom: TgSyncResult;
  getPhoto: TgMediaFile;
  getDocumentThumb: TgMediaFile;
  getDocument: TgMediaFile;
}

export type TgChatMethod = TgChatRequest['method'];
