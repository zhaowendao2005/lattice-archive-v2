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

export interface BaseTileData {
  id: string;
  type: TileItemType;
  title: string;
  size: TileSize;
  groupId: string;
  x: number;
  y: number;
  color?: string;
  customSpan?: { w: number; h: number }; // 允许通过右下角 handle 拖拽自定义尺寸（最小单位格）
  /** 系统级内置应用标识（如聚合搜索），决定点击行为与特殊视觉呈现 */
  systemApp?: 'aggregate-search';
  /** 是否为常驻系统磁贴（禁止从磁贴板移除） */
  undeletable?: boolean;
  /** 若由聚合搜索结果拖入生成，记录来源搜索条目 ID */
  sourceResultId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface FileTileData extends BaseTileData {
  type: 'file';
  fileType: FileCategory;
  extension?: string;
  fileSize?: string;
  description?: string;
  content?: string;
  tags?: string[];
  filePath?: string;
  iconName?: string;
  /** 会话对象支持：会话作为对象/链接存储在 Explore 虚拟文件系统中 */
  sessionId?: string;
  sessionTitle?: string;
  isSessionLink?: boolean;
}

export interface FolderTileData extends BaseTileData {
  type: 'folder';
  children: FileTileData[];
  iconName?: string;
}

export type TileData = FileTileData | FolderTileData;

export interface TileGroupData {
  id: string;
  title: string;
  column: number;
  order: number;
  widthColumns?: number; // 分组/栏的网格列宽（最小单位格数，默认 6）
}

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  tileId: string | null;
  groupId: string | null;
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
