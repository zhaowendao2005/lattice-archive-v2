import type { TgFileInfo, TgPhotoInfo, TgVideoInfo, TgPeerRef } from '../chatProtocol';

export type FileCategory =
  | 'pdf'
  | 'doc'
  | 'code'
  | 'image'
  | 'archive'
  | 'audio'
  | 'video'
  | 'text'
  | 'data'
  | 'exec'
  | 'generic';

export type SearchScopeSessionKind = 'joined' | 'credential_only' | 'explore';

export type SearchTimeRangePreset = 'all' | '24h' | '7d' | '30d' | '90d' | '1y' | 'custom';

export type SearchPreFilterCategory = 'video' | 'image' | 'session' | 'text' | 'other';

export interface AggregateSearchResultItem {
  id: string;
  title: string;
  category: SearchPreFilterCategory;
  categoryLabel: string;
  /** 对应磁贴系统的文件分类，用于拖入左栏文件树时直接生成磁贴 */
  fileType: FileCategory;
  extension: string;
  fileSize: string;
  /** 精确字节体积（用于搜索后体积筛选与排序） */
  sizeBytes?: number;
  /** 视频/音频时长秒数（用于搜索后时长筛选与排序） */
  durationSeconds?: number;
  /** 媒体宽度像素（用于搜索后画质筛选） */
  width?: number;
  /** 媒体高度像素 */
  height?: number;
  /** 原始消息 Unix 秒时间戳 */
  dateSeconds?: number;
  /** 匹配摘要或结构化元数据描述 */
  snippet: string;
  /** 所属会话 ID（对应右栏 SearchScopeSessionDto.id） */
  sessionId: string;
  /** 所属会话标题 */
  sessionTitle: string;
  /** 所属会话类别（已加入 / 只有凭据 / Explore） */
  sessionKind: SearchScopeSessionKind;
  updatedAt: string;
  /** 左端正方形缩略图角标（如视频时长「12:40」、图片尺寸「3840×2160」等） */
  badgeMeta: string;
  /** 左端正方形缩略图内联 Data URL（0ms PhotoStrippedSize 或已解码高清图） */
  thumbnailUrl: string;
  /** 首次映射时拿到的 Tier-0 模糊占位图（与 thumbnailUrl 分离，避免高清图被写入 localStorage） */
  thumbTier0Url?: string;
  /** 是否已完成高清缩略图懒加载升级 */
  hdThumbLoaded?: boolean;
  /** 是否已经尝试过高清缩略图请求（失败后不再自动重复发起，避免日志风暴） */
  hdThumbAttempted?: boolean;
  /** 最近一次高清缩略图失败的分桶代码（如 NO_MEDIA / REF_EXPIRED） */
  hdThumbError?: string;
  /** 拖入磁贴的会话凭据专属补充引用。 */
  inviteHash?: string;
  credentialState?: 'joined' | 'temp_ephemeral' | 'temp_auto_renew';
  peekExpiresAt?: number;
  lastVerifiedAt?: number;
  autoRenew?: boolean;
  /** 产出该结果的 Telegram 账号 ID */
  originAccountId?: string;
  /** 产出该结果的 Peer 引用 */
  peerRef?: TgPeerRef;
  /** 产出该结果的原始消息 ID */
  msgId?: number;
  /** 相册原子组 ID（grouped_id），支持一键整套相册入柜 */
  groupedId?: string;
  /** 同相册内关联的消息 ID 列表 */
  albumMsgIds?: number[];
  /** 是否处于限制转发保护（noforwards） */
  noforwards?: boolean;
  /** 自毁倒计时秒数（ttl_period） */
  ttlPeriod?: number;
  /** 原始照片定位信息（用于懒加载缩略图与查看） */
  photoInfo?: TgPhotoInfo;
  /** 原始视频定位信息（用于流式播放与懒加载封面） */
  videoInfo?: TgVideoInfo;
  /** 原始文件定位信息 */
  fileInfo?: TgFileInfo;
}

/** 流式检索请求参数 */
export interface StreamingSearchQuery {
  keyword: string;
  /** Ignore derived cache to revalidate edits/deletions immediately. */
  forceRefresh?: boolean;
  /** 搜索前选中的文件类型集合（为空表示不限文件类型） */
  preCategories: SearchPreFilterCategory[];
  /** 搜索前文件扩展名筛选；逗号、空格或换行分隔，空值表示不限。 */
  preExtensions?: string[];
  /** 右栏选中的会话范围 ID 集合（为空表示检索全部会话范围） */
  scopeSessionIds: string[];
  /** 搜索前下推过滤：起始 Unix 秒 */
  minDate?: number;
  /** 搜索前下推过滤：截止 Unix 秒 */
  maxDate?: number;
  pageSize: number;
}

/** 流式检索分块推送数据包 */
export interface StreamingSearchChunk {
  items: AggregateSearchResultItem[];
  totalMatched: number;
  hasMore: boolean;
  peerProgress?: SearchPeerProgress;
}

export interface SearchPeerProgress {
  accountId: string;
  peerKey: string;
  status: 'queued' | 'searching' | 'completed' | 'error';
  pages: number;
  checked: number;
  matched: number;
  errorCode?: string;
}


export interface SearchIndexCoverage {
  peerKey: string;
  accountId: string;
  queryKey: string;
  nextOffsetId?: number;
  complete: boolean;
  /** Newest candidate at the time of the original scan. Every run probes above it. */
  headMessageId: number;
  /** Last historical advancement; head-only refresh must not extend the freshness window. */
  updatedAt: number;
}
export interface SearchIndexLookup {
  coverage?: SearchIndexCoverage;
  pageKeys: string[];
  scopeKey: string;
}
export type SearchIndexCommand =
  | { op: 'init'; key: CryptoKey }
  | { op: 'lookup'; accountId: string; peerKey: string; queryKey: string }
  | { op: 'invalidate'; accountId: string; peerKey: string; queryKey: string }
  | { op: 'page'; key: string }
  | { op: 'commit'; accountId: string; peerKey: string; queryKey: string; items: AggregateSearchResultItem[]; coverage: SearchIndexCoverage }
  | { op: 'remove'; accountId: string };
export interface SearchIndexRequest { id: number; command: SearchIndexCommand }
export interface SearchIndexReply { id: number; value?: unknown; error?: string }
