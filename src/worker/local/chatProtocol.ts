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

/** 会话或发送者头像定位信息：strippedThumb 随实体下发，小图（160×160）按可见性经 InputPeerPhotoFileLocation 拉取。 */
export interface TgAvatarInfo {
  photoId: string;
  dcId: number;
  /** 由 strippedThumb 还原的极小 JPEG data URL。 */
  thumb?: string;
}

/** 渐进式流播放的单次分片响应。 */
export interface TgDocumentPart {
  bytes: ArrayBuffer;
  mimeType: string;
  fullSize: number;
}

/** 加入公开频道 / 超级群组的结果：pending 表示已提交入群申请（不能视作已加入），webview 表示需在官方客户端完成验证。 */
export interface TgJoinChatResult {
  status: 'joined' | 'pending' | 'webview';
  dialog?: TgDialogDto;
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

/** 消息文本中的富文本与隐藏链接实体（offset / length 均按 UTF-16 代码单元计数）。 */
export type TgEntityKind =
  | 'textUrl'
  | 'url'
  | 'mention'
  | 'mentionName'
  | 'hashtag'
  | 'cashtag'
  | 'botCommand'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'code'
  | 'pre'
  | 'spoiler'
  | 'blockquote';

export interface TgMessageEntity {
  type: TgEntityKind;
  offset: number;
  length: number;
  /** textUrl 携带的隐藏跳转地址。 */
  url?: string;
  /** mentionName 携带的目标用户 ID。 */
  userId?: string;
  /** pre 代码块语言标识。 */
  language?: string;
  /** blockquote 是否可折叠。 */
  collapsed?: boolean;
}

/** 消息底部的内联按钮（ReplyInlineMarkup）。 */
export type TgInlineButtonKind = 'callback' | 'url' | 'switchInline' | 'webview' | 'copy' | 'other';

export interface TgInlineButton {
  kind: TgInlineButtonKind;
  text: string;
  /** callback 按钮的二进制载荷（base64 编码）。 */
  data?: string;
  /** url / webview 按钮的目标地址。 */
  url?: string;
  /** switchInline 按钮携带的查询词。 */
  query?: string;
  samePeer?: boolean;
  /** copy 按钮携带的复制文本。 */
  copyText?: string;
}

/** 回复引用头信息。 */
export interface TgReplyInfo {
  id: number;
  peerKey?: TgPeerKey;
  quoteText?: string;
}

/** 网页链接预览卡片信息（MessageMediaWebPage）。 */
export interface TgWebPagePreview {
  url: string;
  displayUrl: string;
  siteName?: string;
  title?: string;
  description?: string;
  photo?: TgPhotoInfo;
}

/** 点击机器人 Callback 按钮后的服务端响应。 */
export interface TgCallbackAnswer {
  message?: string;
  alert?: boolean;
  url?: string;
}

/** 私有邀请链接（t.me/+hash）预览信息。 */
export interface TgInvitePreview {
  hash: string;
  status: 'already' | 'peek' | 'invite';
  title: string;
  about?: string;
  participantsCount?: number;
  isChannel?: boolean;
  joinRequest?: boolean;
  dialog?: TgDialogDto;
}

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
  senderAvatar?: TgAvatarInfo;
  /** 频道署名或群内自定义头衔（如截图右上角提示标签）。 */
  postAuthor?: string;
  text: string;
  entities?: TgMessageEntity[];
  media?: TgMessageMedia;
  webPage?: TgWebPagePreview;
  replyToId?: number;
  replyTo?: TgReplyInfo;
  replyMarkup?: TgInlineButton[][];
  repliesCount?: number;
  groupedId?: string;
  forwardedFrom?: string;
  views?: number;
}

export interface TgDialogDto {
  key: TgPeerKey;
  peer: TgPeerRef;
  kind: TgChatKind;
  title: string;
  avatar?: TgAvatarInfo;
  username?: string;
  participantsCount?: number;
  /** 当前用户尚未加入或已退出该公开频道 / 群组。 */
  left?: boolean;
  /** 当前用户已被移出 / 封禁或群组已停用。 */
  kicked?: boolean;
  /** 当前用户是该群组 / 频道的创建者（群主），退出前受角色保护。 */
  creator?: boolean;
  /** 加入该公开群组 / 频道需要管理员审核。 */
  joinRequest?: boolean;
  /** 本次会话中已提交加入申请，正在等待管理员审核。 */
  joinPending?: boolean;
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
  /** 会话归档文件夹变更（0 = 活动，1 = 归档）。 */
  | { type: 'folderPeers'; peers: { peerKey: TgPeerKey; folderId: 0 | 1 }[] }
  /** 单个会话置顶状态变更。 */
  | { type: 'dialogPinned'; peerKey: TgPeerKey; folderId: 0 | 1; pinned: boolean }
  /** 单个会话手动未读标记变更。 */
  | { type: 'dialogUnreadMark'; peerKey: TgPeerKey; unreadMark: boolean }
  /** 频道或群组成员状态变为已退出 / 被移出。 */
  | { type: 'peerLeft'; peerKey: TgPeerKey; kicked?: boolean }
  /** 置顶顺序 / 文件夹等列表结构变化，需要重新拉取会话首页。 */
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
  /** 拉取指定消息 ID 前后的历史上下文（用于跨历史跳转定位与补全被回复消息）。 */
  | { method: 'getHistoryAround'; peer: TgPeerRef; messageId: number; limit: number }
  | { method: 'syncFrom'; state: TgUpdatesState | null }
  /** 下载会话或发送者头像小图（160×160）；群内 min 用户可附带 containerPeer + messageId。 */
  | { method: 'getAvatar'; peer: TgPeerRef; photoId: string; dcId: number; containerPeer?: TgPeerRef; messageId?: number }
  /** 下载照片的某个尺寸档位；peer + messageId 用于 file_reference 过期时重新获取消息。 */
  | { method: 'getPhoto'; peer: TgPeerRef; messageId: number; photo: TgPhotoLocation; size: TgPhotoSize }
  /** 下载文档（视频）缩略图档位。 */
  | { method: 'getDocumentThumb'; peer: TgPeerRef; messageId: number; document: TgDocumentLocation; size: TgPhotoSize }
  /** 下载完整文件：Worker 以 chatProgress 汇报进度，可被 chatCancel 中断。 */
  | { method: 'getDocument'; peer: TgPeerRef; messageId: number; document: TgDocumentLocation; size: number; mimeType: string }
  /** 渐进式流播放：按 512 KiB 对齐区间下载单个分片，可被 chatCancel 中断。 */
  | { method: 'getDocumentPart'; peer: TgPeerRef; messageId: number; document: TgDocumentLocation; offset: number; limit: number; size: number; mimeType: string }
  /** 归档 / 取消归档会话（folders.EditPeerFolders）。 */
  | { method: 'setDialogArchived'; peer: TgPeerRef; archived: boolean }
  /** 按公开 @username 解析频道 / 超级群组 / 用户。 */
  | { method: 'resolveUsername'; username: string }
  /** 加入公开频道或超级群组（channels.JoinChannel）。 */
  | { method: 'joinChat'; peer: TgPeerRef }
  /** 退出频道、超级群组或基础群组（channels.LeaveChannel / messages.DeleteChatUser）。 */
  | { method: 'leaveChat'; peer: TgPeerRef }
  /** 删除会话（针对用户间私聊，支持同时为对方删除 revoke: true；群组/频道转为退出）。 */
  | { method: 'deleteChat'; peer: TgPeerRef; revoke?: boolean }
  /** 发送文本消息（支持搜索群关键词输入、命令发送、回复指定消息）。 */
  | { method: 'sendMessage'; peer: TgPeerRef; text: string; replyToMsgId?: number }
  /** 唤醒机器人并传递深链参数（messages.StartBot 或 /start）。 */
  | { method: 'startBot'; bot: TgPeerRef; startParam: string }
  /** 点击消息下方的 Callback 内联按钮（messages.GetBotCallbackAnswer）。 */
  | { method: 'pressBotCallback'; peer: TgPeerRef; messageId: number; data: string }
  /** 检查私有邀请链接（messages.CheckChatInvite）。 */
  | { method: 'checkChatInvite'; hash: string }
  /** 通过私有邀请链接加入群组或频道（messages.ImportChatInvite）。 */
  | { method: 'importChatInvite'; hash: string };

export interface TgChatResponseMap {
  getDialogs: TgDialogPage;
  getHistory: TgHistoryPage;
  getHistoryAround: TgHistoryPage;
  syncFrom: TgSyncResult;
  getAvatar: TgMediaFile;
  getPhoto: TgMediaFile;
  getDocumentThumb: TgMediaFile;
  getDocument: TgMediaFile;
  getDocumentPart: TgDocumentPart;
  setDialogArchived: { folderId: 0 | 1 };
  resolveUsername: TgDialogDto | null;
  joinChat: TgJoinChatResult;
  leaveChat: { ok: true };
  deleteChat: { ok: true };
  sendMessage: TgMessageDto | null;
  startBot: TgMessageDto | null;
  pressBotCallback: TgCallbackAnswer;
  checkChatInvite: TgInvitePreview;
  importChatInvite: TgJoinChatResult;
}

export type TgChatMethod = TgChatRequest['method'];
