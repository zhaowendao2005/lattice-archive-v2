import type {
  TgFileInfo,
  TgPhotoInfo,
  TgVideoInfo,
} from '@/worker/local/chatProtocol';

export type TileSize = 'small' | 'medium' | 'wide' | 'large';

export type TileItemType = 'file' | 'folder';

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

/** 缩略图生命周期状态 */
export type TileThumbStatus = 'ready' | 'pending' | 'failed' | 'none';

/** 会话凭据三态标识 */
export type SessionCredentialState = 'joined' | 'temp_ephemeral' | 'temp_auto_renew';

/** 磁贴缩略图元数据（双层缓存：0ms 内存 strippedDataUrl + OPFS 持久化高清 WebP） */
export interface TileThumbMeta {
  status: TileThumbStatus;
  /** OPFS 相对路径，如 /thumbs/{tileId}.webp */
  opfsPath?: string;
  /** 0ms 瞬时模糊占位图（来自 PhotoStrippedSize / ChatPhoto.strippedThumb） */
  strippedDataUrl?: string;
  /** 内存 ObjectURL（运行期按需生成并回收） */
  objectUrl?: string;
  retryCount: number;
  lastErrorCode?: 'FILE_REFERENCE_EXPIRED' | 'FLOOD_WAIT' | 'CHANNEL_PRIVATE' | 'NETWORK';
  nextRetryAt?: number;
  /** 过期自愈重取锚点 */
  sourceRef?: {
    accountId: string;
    peerId: string;
    peerType?: 'user' | 'chat' | 'channel';
    accessHash?: string;
    msgId?: number;
    photoId?: string;
    dcId?: number;
    thumbType?: string;
  };
}

/** 媒体磁贴的一鱼多吃多源定位锚点 */
export interface TileMediaSource {
  kind: 'origin' | 'vault';
  accountId: string;
  peerKey: string;
  peerId: string;
  peerType: 'user' | 'chat' | 'channel';
  accessHash?: string;
  msgId: number;
  topMsgId?: number;
  groupedId?: string;
  documentId?: string;
  documentAccessHash?: string;
  fileReference?: string;
  dcId?: number;
}

export interface BaseTileData {
  id: string;
  type: TileItemType;
  title: string;
  size: TileSize;
  groupId: string;
  /** 若处于某个文件夹内部，记录父文件夹 ID（顶层磁贴为空） */
  parentId?: string;
  x: number;
  y: number;
  color?: string;
  customSpan?: { w: number; h: number }; // 允许通过右下角 handle 拖拽自定义尺寸（最小单位格）
  /** 系统级内置应用标识（如聚合搜索、会话管理中心），决定点击行为与特殊视觉呈现 */
  systemApp?: 'aggregate-search' | 'session-manager';
  /** 是否为常驻系统磁贴（禁止从磁贴板移除） */
  undeletable?: boolean;
  /** 若由聚合搜索结果导入，记录来源搜索条目 ID；不是资源身份键。 */
  sourceResultId?: string;
  /** 磁贴缩略图生命周期与双层引用 */
  thumb?: TileThumbMeta;
  /** 毫秒级逻辑修改时间戳（用于 CRDT LWW 合并） */
  updatedAtMs?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FileTileData extends BaseTileData {
  type: 'file';
  /** Stable reference to the canonical ExploreResource shared by multiple tile instances. */
  resourceId?: string;
  fileType: FileCategory;
  extension?: string;
  fileSize?: string;
  sizeBytes?: number;
  description?: string;
  content?: string;
  tags?: string[];
  filePath?: string;
  iconName?: string;
  /** 会话对象支持：会话作为对象/链接存储在 Explore 虚拟文件系统中 */
  sessionId?: string;
  sessionTitle?: string;
  isSessionLink?: boolean;
  /** 归属或发现该会话/媒体的本地 Telegram 账号 ID */
  accountId?: string;
  peerKey?: string;
  peerType?: 'user' | 'chat' | 'channel';
  accessHash?: string;
  username?: string;
  inviteHash?: string;
  /** 会话磁贴三态：🟢已加入 / 🟠临时（无续期） / 🟣临时（自动续期） */
  sessionCredentialState?: SessionCredentialState;
  /** 针对 ChatInvitePeek 临时凭据的精确过期毫秒时间戳 */
  peekExpiresAt?: number;
  /** 最近一次凭据探活校验时间 */
  lastVerifiedAt?: number;
  /** 是否启用自动续期巡检 */
  autoRenew?: boolean;
  /** 成员数量或订阅数 */
  participantsCount?: number;
  /** 未读消息数 */
  unreadCount?: number;
  /** 是否在 Telegram 置于归档文件夹 (folder_id=1) */
  archivedInTg?: boolean;
  /** 视频/媒体专属元数据 */
  videoDuration?: number;
  videoWidth?: number;
  videoHeight?: number;
  /** 源消息或频道是否开启限制转发（noforwards） */
  noforwards?: boolean;
  /** 是否已转存至共享私密保险库群 */
  hasVaultCopy?: boolean;
  /** 共享保险库群引用 */
  vaultRef?: {
    vaultPeerKey: string;
    topicId: number;
    msgId: number;
  };
  /** 多源冗余挂载列表（原始频道 + 保险库备份） */
  sources?: TileMediaSource[];
  /** 相册原子组 ID（grouped_id），支持相册套图磁贴 */
  groupedId?: string;
  /** 相册内包含的媒体项数量 */
  albumCount?: number;
  /** 自毁/限时消息倒计时秒数（ttl_period） */
  ttlPeriod?: number;
  /** 是否钉选为永不驱逐的离线媒体资产 */
  pinnedOffline?: boolean;
  /** 原始照片定位信息（用于重新载入/刷新媒体封面） */
  photoInfo?: TgPhotoInfo;
  /** 原始视频定位信息（用于重新载入/刷新视频封面） */
  videoInfo?: TgVideoInfo;
  /** 原始文档定位信息（用于重新载入/刷新文档缩略图） */
  fileInfo?: TgFileInfo;
}

export interface FolderTileData extends BaseTileData {
  type: 'folder';
  /** 支持无限层级递归嵌套：子项可为 FileTileData 或子 FolderTileData */
  children: (FileTileData | FolderTileData)[];
  iconName?: string;
}

export type TileData = FileTileData | FolderTileData;

export interface TileGroupData {
  id: string;
  title: string;
  column: number;
  order: number;
  widthColumns?: number; // 分组/栏的网格列宽（最小单位格数，默认 6）
  updatedAtMs?: number;
}

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  tileId: string | null;
  groupId: string | null;
  folderId?: string | null;
  isFolder: boolean;
  isBoard?: boolean;
}

export interface DragState {
  isDragging: boolean;
  tile: TileData | null;
  sourceGroupId: string | null;
  /** 若磁贴来自某个文件夹内部，记录源文件夹 id（用于拖出/跨文件夹移动） */
  sourceFolderId: string | null;
  currentGroupId: string | null;
  ghostX: number;
  ghostY: number;
  pointerX: number;
  pointerY: number;
  offsetX: number;
  offsetY: number;
  hoverTargetTileId: string | null;
  hoverTargetType: 'folder' | 'file' | null;
  /** 文件夹意图档位：none → candidate（候选）→ locked（锁定） */
  hoverPhase: 'none' | 'candidate' | 'locked';
  /** 文件夹意图置信度 0~1（仅 hoverPhase 非 none 时有意义） */
  hoverConfidence: number;
  isMergeReady: boolean;
  displacedPositions: Record<string, { x: number; y: number }>;
}

export interface GroupDragState {
  isDragging: boolean;
  groupId: string | null;
  targetGroupId: string | null;
  dropPosition: 'before' | 'after' | null;
  dropMode?: 'reorder' | 'new-column';
  targetColumnIndex?: number | null;
  pointerX: number;
  pointerY: number;
}

