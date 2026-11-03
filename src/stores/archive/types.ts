/**
 * ============================================================================
 * 聚合搜索与归档工作台业务域类型契约 (Explore Archive & Search Domain Types)
 * ============================================================================
 * 定义聚合搜索对话框的筛选维度、右栏会话范围模型、流式搜索结果卡片 DTO、
 * 跨栏拖拽归档、五子域本地存储配额、多账号治理、会话管理中心与云同步契约。
 */
import type {
  FileCategory,
  SessionCredentialState,
  TileData,
  TileGroupData,
} from '@/views/main/archive/types/tile';
import type {
  TgFileInfo,
  TgPeerRef,
  TgPhotoInfo,
  TgVideoInfo,
} from '@/worker/local/chatProtocol';

/**
 * 搜索前筛选支持的文件类型（支持多选）：
 * - video: 视频
 * - image: 图片
 * - session: 会话
 * - text: 文本文件
 * - other: 其他
 */
export type SearchPreFilterCategory = 'video' | 'image' | 'session' | 'text' | 'other';

/** 筛选下拉菜单顶部分段：「搜索前」与「搜索后」 */
export type SearchFilterStage = 'pre' | 'post';

/** 搜索前时间跨度快捷档位 */
export type SearchTimeRangePreset = 'all' | '24h' | '7d' | '30d' | '90d' | '1y' | 'custom';

/** 搜索后秒级筛选：时长区间档位 */
export type PostFilterDurationRange = 'all' | 'short' | 'medium' | 'long';

/** 搜索后秒级筛选：分辨率档位 */
export type PostFilterResolutionTier = 'all' | '720p' | '1080p' | '4k';

/** 搜索后秒级筛选：文件体积档位 */
export type PostFilterSizeRange = 'all' | 'lt50m' | '50m_500m' | 'gt500m';

/** 搜索后排序维度 */
export type PostFilterSortBy = 'relevance' | 'date_desc' | 'size_desc' | 'duration_desc';

/**
 * 右栏搜索范围控制的会话分类：
 * - joined: 第一类 —— 所有已加入的会话
 * - credential_only: 第二类 —— 所有只有凭据的会话
 * - explore: 第三类 —— Explore 空间中归类的会话结构专有栏
 */
export type SearchScopeSessionKind = 'joined' | 'credential_only' | 'explore';

/** 文件类型可选项元数据描述 */
export interface SearchCategoryOption {
  value: SearchPreFilterCategory;
  label: string;
  shortCode: string;
  description: string;
}

/** 右栏搜索范围中的单个会话源条目 */
export interface SearchScopeSessionDto {
  id: string;
  title: string;
  initials: string;
  kind: SearchScopeSessionKind;
  /** 会话形态说明（如「研发频道」「超级群组」「私密对话」） */
  peerTypeLabel: string;
  /** 仅「只有凭据的会话」携带的凭据来源标识（如「access_hash 凭据」「@username 句柄」「邀请快照」） */
  credentialBadge?: string;
  /** 仅「只有凭据的会话」携带的过期绝对时间 */
  expiresAt?: string;
  /** 仅「只有凭据的会话」携带的过期展示文案（如「剩余 14 天」「2026-11-20 到期」） */
  expiresLabel?: string;
  /** 句柄或哈希摘要展示 */
  handleOrHash: string;
  /** 规模或快照容量说明 */
  itemCountLabel: string;
  /** 缩略方块背景色类 */
  accentClass: string;
  /** 归属账号 ID */
  accountId?: string;
  /** 关联的 Telegram Peer 引用 */
  peerRef?: TgPeerRef;
  /** 关联的公开用户名 */
  username?: string;
  /** 关联的私有邀请哈希 */
  inviteHash?: string;
  /** 会话凭据三态 */
  credentialState?: SessionCredentialState;
  /** ChatInvitePeek 毫秒过期时间 */
  peekExpiresAt?: number;
}

/** 左栏 Explore 树 macOS 上下文菜单状态 */
export interface TreeContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  targetType: 'group' | 'folder' | 'file' | 'subfile' | 'blank';
  groupId?: string;
  folderId?: string;
  fileId?: string;
  title: string;
  isUndeletable?: boolean;
}

/** 左栏 Explore 树资源管理器式行内重命名状态 */
export interface TreeEditingNodeState {
  isEditing: boolean;
  targetType: 'group' | 'folder' | 'file' | 'subfile' | null;
  id: string | null;
  parentId?: string;
  title: string;
}

/** 聚合搜索流式返回的单张结果卡片 DTO */
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
  /** 搜索前选中的文件类型集合（为空表示不限文件类型） */
  preCategories: SearchPreFilterCategory[];
  /** 右栏选中的会话范围 ID 集合（为空表示检索全部会话范围） */
  scopeSessionIds: string[];
  /** 搜索前下推过滤：时间跨度档位 */
  timeRange?: SearchTimeRangePreset;
  /** 搜索前下推过滤：起始 Unix 秒 */
  minDate?: number;
  /** 搜索前下推过滤：截止 Unix 秒 */
  maxDate?: number;
  /** 搜索前下推过滤：指定发送者 PeerKey (from_id) */
  fromPeerKey?: string;
  /** 搜索前下推过滤：Forum 话题消息 ID (top_msg_id) */
  topMsgId?: number;
  /** 指定检索账号集合（为空表示检索所有在线/温池账号） */
  accountIds?: string[];
  page: number;
  pageSize: number;
}

/** 流式检索分块推送数据包 */
export interface StreamingSearchChunk {
  items: AggregateSearchResultItem[];
  totalMatched: number;
  hasMore: boolean;
  isFinalChunkOfPage: boolean;
  /** 标识该分块来自哪个检索层级：Tier 0(本地索引) / Tier 1(服务端全局) / Tier 2(定向会话) */
  sourceTier?: 0 | 1 | 2;
}

/** 中栏搜索结果向左栏文件树（磁贴拓扑）拖拽的实时状态 */
export interface SearchToTreeDragState {
  isDragging: boolean;
  items: AggregateSearchResultItem[];
  pointerX: number;
  pointerY: number;
  hoverTargetType: 'group' | 'folder' | null;
  hoverTargetId: string | null;
  hoverTargetTitle: string | null;
}

/**
 * ============================================================================
 * Phase 1: 五大本地存储子域配额与淘汰治理契约
 * ============================================================================
 */
export type StorageSubDomainId =
  | 'core-metadata'
  | 'explore-thumbs'
  | 'chat-media-cache'
  | 'search-stream-buffer'
  | 'explore-offline-blobs';

export type EvictionPolicyKind =
  | 'never'
  | 'orphan-gc-lru'
  | 'ttl-lru'
  | 'ring-buffer-fifo'
  | 'lru-unpinned';

export interface StorageSubDomainQuota {
  id: StorageSubDomainId;
  title: string;
  description: string;
  storageLocation: string;
  defaultLimitMB: number;
  minLimitMB: number;
  maxLimitMB: number;
  configuredLimitMB: number;
  usedBytes: number;
  itemCount: number;
  evictionPolicy: EvictionPolicyKind;
}

/** OPFS 中持久化的单文件 LRU 追踪记录 */
export interface OpfsFileEntryMeta {
  path: string;
  subDomain: StorageSubDomainId;
  sizeBytes: number;
  lastAccessedAt: number;
  createdAt: number;
  pinned?: boolean;
  tileId?: string;
}

/** Explore 根清单文件 (/explore-manifest.v2.json) 数据结构 */
export interface ExploreManifestV2 {
  schemaVersion: 2;
  revision: number;
  updatedAtMs: number;
  deviceId: string;
  groups: TileGroupData[];
  tiles: TileData[];
  tombstones: Record<string, number>;
  tempCredentials: TempSessionCredential[];
  vaultConfig?: SharedVaultGroupConfig;
  quotaPolicy?: UserQuotaPolicyConfig;
}

/**
 * ============================================================================
 * Phase 2 & 3: 临时会话凭据池、多账号设备槽位矩阵与智能配额规则
 * ============================================================================
 */
export interface TempSessionCredential {
  id: string;
  peerKey: string;
  peerId: string;
  peerType: 'user' | 'chat' | 'channel';
  accessHash?: string;
  title: string;
  username?: string;
  inviteHash?: string;
  accountId: string;
  state: SessionCredentialState;
  /** 仅针对 ChatInvitePeek 的精确过期毫秒时间戳 */
  peekExpiresAt?: number;
  lastVerifiedAt: number;
  autoRenew: boolean;
  participantsCount?: number;
  about?: string;
  /** 关联的磁贴 ID 列表 */
  linkedTileIds: string[];
  status: 'healthy' | 'expiring_soon' | 'expired' | 'invalid';
}

export type QuotaRuleKey =
  | 'joinChannel'
  | 'checkChatInvite'
  | 'resolveUsername'
  | 'botCallbackPage'
  | 'messagesSearch';

export interface QuotaRuleItem {
  key: QuotaRuleKey;
  label: string;
  apiMethodDesc: string;
  maxCount: number;
  windowMinutes: number;
  minIntervalMs: number;
  jitterMs: number;
  /** 当前窗口内按账号统计的已消耗次数 */
  usedByAccount: Record<string, { count: number; windowStartMs: number; cooldownUntilMs?: number }>;
}

export interface UserQuotaPolicyConfig {
  mode: 'conservative' | 'standard' | 'aggressive' | 'custom';
  globalConcurrency: number;
  autoRotateAccount: boolean;
  pauseOnFloodWait: boolean;
  rules: Record<QuotaRuleKey, QuotaRuleItem>;
}

export type { DeviceFingerprintProfile } from '@/types/sessionBatch';
import type { DeviceFingerprintProfile } from '@/types/sessionBatch';

/** 预备槽位 (PendingSlot) 状态 */
export type PendingSlotStatus =
  | 'healthy_standby'
  | 'in_24h_Restriction'
  | 'activated'
  | 'expired'
  | 'spawning';

/** 预备槽位记录（AES-GCM-256 密文存储于本地 IndexedDB 及可选云端槽位池） */
export interface PendingSlotRecord {
  slotId: string;
  accountId: string;
  sealedSession: string;
  deviceFingerprint: DeviceFingerprintProfile;
  createdAtMs: number;
  confirmedOfficial: boolean;
  restrictionEndsAtMs: number;
  lastKeepaliveAtMs: number;
  status: PendingSlotStatus;
}

/** 单账号凭据治理与健康探针记录 */
export interface AccountCredentialGovernanceRecord {
  accountId: string;
  phone?: string;
  username?: string;
  displayName: string;
  isPremium: boolean;
  dcId: number;
  tier: 'P0_foreground' | 'P1_warm_active' | 'P2_cold_standby';
  healthStatus: 'healthy' | 'probation_24h' | 'flood_wait' | 'auth_invalid' | 'offline';
  floodWaitUntilMs?: number;
  joinedChannelsCount: number;
  maxChannelsLimit: number;
  accountTtlDays: number;
  authorizationTtlDays: number;
  deviceFingerprint: DeviceFingerprintProfile;
  activeSessionsCount: number;
  pendingSlots: PendingSlotRecord[];
  lastAuditAtMs?: number;
  lastKeepaliveAtMs?: number;
}

/** 共享私密保险库群与五大标准 Forum Topics 配置 */
export interface SharedVaultGroupConfig {
  enabled: boolean;
  vaultPeerKey: string;
  vaultTitle: string;
  ownerAccountId: string;
  memberAccountIds: string[];
  topics: {
    video: number;     // 🎬 视频归档卷
    photo: number;     // 🖼️ 图集原图卷
    document: number;  // 📦 冷备文档卷
    beacon: number;    // 📡 跨设备凭据信标卷
    manifest: number;  // 🗂️ 归档索引清单卷
  };
  lastBeaconSyncAtMs?: number;
}

/**
 * ============================================================================
 * Phase 4: 搜索机器人闭区间 [startPage, endPage] 自动收割机契约
 * ============================================================================
 */
export type { BotHarvestCandidateItem } from '@/types/botHarvest';
import type { BotHarvestCandidateItem } from '@/types/botHarvest';

export interface BotHarvestTaskState {
  taskId: string;
  peerKey: string;
  messageId: number;
  botName: string;
  startPage: number;
  endPage: number;
  currentPage: number;
  status: 'idle' | 'running' | 'paused_captcha' | 'completed' | 'cancelled' | 'error';
  pauseReason?: string;
  candidates: BotHarvestCandidateItem[];
  targetGroupId: string;
  targetFolderId: string | null;
  autoJoinAndArchive: boolean;
  startedAtMs?: number;
}

/** 全局后台任务与配额监控 HUD 任务项 */
export interface BackgroundTaskItem {
  id: string;
  kind: 'bot_harvest' | 'batch_join_archive' | 'vault_clone' | 'credential_patrol' | 'cloud_sync' | 'session_import';
  title: string;
  subtitle: string;
  progressCurrent: number;
  progressTotal: number;
  status: 'running' | 'paused' | 'completed' | 'failed';
  accountId?: string;
  errorMessage?: string;
  createdAtMs: number;
}

/**
 * ============================================================================
 * Phase 5: Cloudflare D1 单行 Gzip 快照与 CRDT 三路合并契约
 * ============================================================================
 */
export type SyncIntervalMode = 'manual' | '5m' | '15m' | '1h' | 'on_close';

export interface CloudSyncState {
  status: 'idle' | 'syncing' | 'synced' | 'conflict_merged' | 'error';
  syncInterval: SyncIntervalMode;
  lastSyncedRevision: number;
  lastSyncedAtMs: number | null;
  lastPayloadBytes: number;
  errorMessage: string | null;
}

