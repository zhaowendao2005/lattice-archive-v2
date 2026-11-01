/**
 * ============================================================================
 * 聚合搜索业务域类型契约 (Aggregate Search Domain Types)
 * ============================================================================
 * 定义聚合搜索对话框的筛选维度、右栏会话范围模型、流式搜索结果卡片 DTO
 * 以及跨栏拖拽归档至左栏磁贴文件树（Explorer Tree）的状态结构。
 */
import type { FileCategory } from '@/views/main/archive/types/tile';

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
  /** 匹配摘要或结构化元数据描述 */
  snippet: string;
  /** 所属会话 ID（对应右栏 SearchScopeSessionDto.id） */
  sessionId: string;
  /** 所属会话标题 */
  sessionTitle: string;
  /** 所属会话类别（已加入 / 只有凭据） */
  sessionKind: SearchScopeSessionKind;
  updatedAt: string;
  /** 左端正方形缩略图角标（如视频时长「12:40」、图片尺寸「3840×2160」等） */
  badgeMeta: string;
  /** 左端正方形缩略图内联 SVG Data URL */
  thumbnailUrl: string;
}

/** 流式检索请求参数 */
export interface StreamingSearchQuery {
  keyword: string;
  /** 搜索前选中的文件类型集合（为空表示不限文件类型） */
  preCategories: SearchPreFilterCategory[];
  /** 右栏选中的会话范围 ID 集合（为空表示检索全部会话范围） */
  scopeSessionIds: string[];
  page: number;
  pageSize: number;
}

/** 流式检索分块推送数据包 */
export interface StreamingSearchChunk {
  items: AggregateSearchResultItem[];
  totalMatched: number;
  hasMore: boolean;
  isFinalChunkOfPage: boolean;
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
