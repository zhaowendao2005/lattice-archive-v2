import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type {
  ContextMenuState,
  DragState,
  FileTileData,
  FolderTileData,
  GroupDragState,
  TileData,
  TileGroupData,
  TileSize,
} from '../types/tile';

const STORAGE_KEY = 'lattice_archive_tiles_win10_v2';

export const GROUP_COLUMNS = 6;
export const UNIT_SIZE = 50;
export const GRID_GAP = 6;

export function getTileSpan(size: TileSize, customSpan?: { w: number; h: number }): { w: number; h: number } {
  if (customSpan && customSpan.w > 0 && customSpan.h > 0) {
    return { w: customSpan.w, h: customSpan.h };
  }
  switch (size) {
    case 'small':
      return { w: 1, h: 1 };
    case 'medium':
      return { w: 2, h: 2 };
    case 'wide':
      return { w: 4, h: 2 };
    case 'large':
      return { w: 4, h: 4 };
  }
}

export function getTilePixelDimensions(
  size: TileSize,
  customSpan?: { w: number; h: number },
): { width: number; height: number } {
  const span = getTileSpan(size, customSpan);
  return {
    width: span.w * UNIT_SIZE + (span.w - 1) * GRID_GAP,
    height: span.h * UNIT_SIZE + (span.h - 1) * GRID_GAP,
  };
}

function getDefaultGroups(): TileGroupData[] {
  return [
    { id: 'group-common', title: '常用目录及云存储', column: 0, order: 0, widthColumns: 6 },
    { id: 'group-work', title: '开发与研发 (Work)', column: 0, order: 1, widthColumns: 6 },
    { id: 'group-internet', title: '互联网与服务 (Internet)', column: 1, order: 0, widthColumns: 6 },
    { id: 'group-media', title: '影音与多媒体', column: 2, order: 0, widthColumns: 6 },
    { id: 'group-tools', title: '实用工具 (Tools)', column: 2, order: 1, widthColumns: 6 },
  ];
}

function getDefaultTiles(): TileData[] {
  return [
    // --- Group 1: 常用目录及云存储 ---
    {
      id: 'tile-mine',
      type: 'file',
      title: 'mine 个人工作台',
      size: 'medium',
      groupId: 'group-common',
      x: 0,
      y: 0,
      fileType: 'doc',
      extension: 'md',
      description: '个人日常笔记、待办事项与敏捷计划',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-toolbox-folder',
      type: 'folder',
      title: '我的工具箱',
      size: 'medium',
      groupId: 'group-common',
      x: 2,
      y: 0,
      children: [
        {
          id: 'sub-term',
          type: 'file',
          title: '终端快捷配置',
          size: 'small',
          groupId: 'group-common',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'json',
          description: 'WezTerm 与 PowerShell 配置文件',
          createdAt: '2026-10-02',
          updatedAt: '2026-10-09',
        },
        {
          id: 'sub-net',
          type: 'file',
          title: '网络延迟测试',
          size: 'small',
          groupId: 'group-common',
          x: 0,
          y: 0,
          fileType: 'exec',
          extension: 'exe',
          description: '全网节点测速诊断工具',
          createdAt: '2026-10-03',
          updatedAt: '2026-10-09',
        },
        {
          id: 'sub-sys',
          type: 'file',
          title: '系统硬件信息',
          size: 'small',
          groupId: 'group-common',
          x: 0,
          y: 0,
          fileType: 'data',
          extension: 'nfo',
          description: '系统硬件概要清单',
          createdAt: '2026-10-04',
          updatedAt: '2026-10-08',
        },
        {
          id: 'sub-clean',
          type: 'file',
          title: '缓存清理脚本',
          size: 'small',
          groupId: 'group-common',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'bat',
          description: '临时目录与构建产物一键清理',
          createdAt: '2026-10-05',
          updatedAt: '2026-10-07',
        },
      ],
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-photo-1',
      type: 'file',
      title: '图库',
      size: 'small',
      groupId: 'group-common',
      x: 4,
      y: 0,
      fileType: 'image',
      extension: 'png',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-music-1',
      type: 'file',
      title: '音频',
      size: 'small',
      groupId: 'group-common',
      x: 5,
      y: 0,
      fileType: 'audio',
      extension: 'flac',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-cloud-1',
      type: 'file',
      title: '云盘',
      size: 'small',
      groupId: 'group-common',
      x: 4,
      y: 1,
      fileType: 'archive',
      extension: 'zip',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-down-1',
      type: 'file',
      title: '下载',
      size: 'small',
      groupId: 'group-common',
      x: 5,
      y: 1,
      fileType: 'data',
      extension: 'dat',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-startup-conf',
      type: 'file',
      title: '配置开机自启动项',
      size: 'medium',
      groupId: 'group-common',
      x: 0,
      y: 2,
      fileType: 'code',
      extension: 'bat',
      description: 'Windows 桌面环境初始化自动加载项',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-ahk-folder',
      type: 'folder',
      title: 'AHK 快捷键脚本',
      size: 'medium',
      groupId: 'group-common',
      x: 2,
      y: 2,
      children: [
        {
          id: 'sub-ahk-win',
          type: 'file',
          title: '窗口快速平铺',
          size: 'small',
          groupId: 'group-common',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'ahk',
          createdAt: '2026-10-01',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-ahk-text',
          type: 'file',
          title: '快速文字片段',
          size: 'small',
          groupId: 'group-common',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'ahk',
          createdAt: '2026-10-01',
          updatedAt: '2026-10-10',
        },
      ],
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-note-1',
      type: 'file',
      title: '便签',
      size: 'small',
      groupId: 'group-common',
      x: 4,
      y: 2,
      fileType: 'text',
      extension: 'txt',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-calc-1',
      type: 'file',
      title: '计算器',
      size: 'small',
      groupId: 'group-common',
      x: 5,
      y: 2,
      fileType: 'exec',
      extension: 'exe',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-clean-recycle',
      type: 'file',
      title: '回收站整理',
      size: 'small',
      groupId: 'group-common',
      x: 4,
      y: 3,
      fileType: 'generic',
      extension: 'sys',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-home-hub',
      type: 'file',
      title: '主目录索引',
      size: 'small',
      groupId: 'group-common',
      x: 5,
      y: 3,
      fileType: 'doc',
      extension: 'pdf',
      createdAt: '2026-10-01',
      updatedAt: '2026-10-10',
    },

    // --- Group 2: 开发与研发 (Work) ---
    {
      id: 'tile-work-spec',
      type: 'file',
      title: '系统架构设计方案',
      size: 'medium',
      groupId: 'group-work',
      x: 0,
      y: 0,
      fileType: 'pdf',
      extension: 'pdf',
      description: 'Capacitor + Electron 跨平台系统架构与安全隔离规范',
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-work-chat',
      type: 'folder',
      title: 'chat 协作归档',
      size: 'medium',
      groupId: 'group-work',
      x: 2,
      y: 0,
      children: [
        {
          id: 'sub-chat-1',
          type: 'file',
          title: '设计讨论记录',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'text',
          extension: 'md',
          createdAt: '2026-10-08',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-chat-2',
          type: 'file',
          title: '联调问题汇总',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'doc',
          extension: 'docx',
          createdAt: '2026-10-08',
          updatedAt: '2026-10-10',
        },
      ],
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-work-code',
      type: 'folder',
      title: 'Code And Design',
      size: 'medium',
      groupId: 'group-work',
      x: 4,
      y: 0,
      children: [
        {
          id: 'sub-code-ts',
          type: 'file',
          title: 'main.ts 入口',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'ts',
          createdAt: '2026-10-07',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-code-fig',
          type: 'file',
          title: 'UI视觉规范原稿',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'image',
          extension: 'fig',
          createdAt: '2026-10-07',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-code-css',
          type: 'file',
          title: 'Tailwind 令牌',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'css',
          createdAt: '2026-10-07',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-code-sql',
          type: 'file',
          title: 'SQLite 表初始化',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'data',
          extension: 'sql',
          createdAt: '2026-10-07',
          updatedAt: '2026-10-10',
        },
      ],
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-work-obsidian',
      type: 'file',
      title: 'Obsidian 研发知识库',
      size: 'medium',
      groupId: 'group-work',
      x: 0,
      y: 2,
      fileType: 'doc',
      extension: 'md',
      description: '本地离线知识索引与双向链接图谱',
      createdAt: '2026-10-07',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-work-wide',
      type: 'file',
      title: '量子网格动力学模拟报告 (2026)',
      size: 'wide',
      groupId: 'group-work',
      x: 2,
      y: 2,
      fileType: 'data',
      extension: 'dat',
      description: '包含 5000+ 节点晶格动力学常数模拟数据及图谱导出',
      createdAt: '2026-10-08',
      updatedAt: '2026-10-10',
    },

    // --- Group 3: 互联网与服务 (Internet) ---
    {
      id: 'tile-net-chrome',
      type: 'file',
      title: 'Chrome 浏览器会话',
      size: 'medium',
      groupId: 'group-internet',
      x: 0,
      y: 0,
      fileType: 'generic',
      extension: 'html',
      description: '工作区标签页集合与书签归档',
      createdAt: '2026-10-02',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-net-wandacloud',
      type: 'file',
      title: 'wandacloud 云盘',
      size: 'medium',
      groupId: 'group-internet',
      x: 2,
      y: 0,
      fileType: 'archive',
      extension: 'cloud',
      description: '离线同步网盘与实时备份节点',
      createdAt: '2026-10-04',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-net-edge',
      type: 'file',
      title: 'Microsoft Edge 配置',
      size: 'medium',
      groupId: 'group-internet',
      x: 4,
      y: 0,
      fileType: 'generic',
      extension: 'xml',
      createdAt: '2026-10-04',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-net-wezterm',
      type: 'file',
      title: 'wezterm-gui 终端',
      size: 'medium',
      groupId: 'group-internet',
      x: 0,
      y: 2,
      fileType: 'code',
      extension: 'lua',
      description: 'GPU 加速跨平台终端与多分屏预设',
      createdAt: '2026-10-06',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-net-clash',
      type: 'file',
      title: 'clash-verge 规则库',
      size: 'medium',
      groupId: 'group-internet',
      x: 2,
      y: 2,
      fileType: 'data',
      extension: 'yaml',
      description: '分流规则与高速网关配置文件',
      createdAt: '2026-10-06',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-net-api-wide',
      type: 'file',
      title: '微服务网关 RESTful API 契约',
      size: 'wide',
      groupId: 'group-internet',
      x: 0,
      y: 4,
      fileType: 'code',
      extension: 'json',
      description: 'OpenAPI 3.1 协议规范与端点路由表',
      createdAt: '2026-10-07',
      updatedAt: '2026-10-10',
    },

    // --- Group 4: 影音与多媒体 ---
    {
      id: 'tile-media-music',
      type: 'file',
      title: 'Apple Music 离线缓存',
      size: 'medium',
      groupId: 'group-media',
      x: 0,
      y: 0,
      fileType: 'audio',
      extension: 'm4a',
      description: '无损音频离线缓存库',
      createdAt: '2026-10-03',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-media-bili',
      type: 'file',
      title: '哔哩哔哩 收藏视频',
      size: 'medium',
      groupId: 'group-media',
      x: 2,
      y: 0,
      fileType: 'video',
      extension: 'mp4',
      description: '技术分享与番剧离线缓存',
      createdAt: '2026-10-03',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-media-decode',
      type: 'file',
      title: '网易云 ncm 解密脚本',
      size: 'medium',
      groupId: 'group-media',
      x: 0,
      y: 2,
      fileType: 'code',
      extension: 'bat',
      description: 'NCM 加密音频转 FLAC 无损处理工具',
      createdAt: '2026-10-04',
      updatedAt: '2026-10-10',
    },

    // --- Group 5: 实用工具 (Tools) ---
    {
      id: 'tile-tool-localsend',
      type: 'file',
      title: 'LocalSend 局域网互传',
      size: 'medium',
      groupId: 'group-tools',
      x: 0,
      y: 0,
      fileType: 'exec',
      extension: 'exe',
      description: '跨平台零流量局域网安全直连',
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-tool-everything',
      type: 'file',
      title: 'Everything 极速索引',
      size: 'medium',
      groupId: 'group-tools',
      x: 2,
      y: 0,
      fileType: 'data',
      extension: 'db',
      description: 'NTFS 全盘秒级文件名搜索数据库',
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-tool-treesize',
      type: 'file',
      title: 'TreeSize 空间分析',
      size: 'medium',
      groupId: 'group-tools',
      x: 4,
      y: 0,
      fileType: 'data',
      extension: 'dat',
      description: '磁盘占用深度树形扫描',
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-tool-folder-doc',
      type: 'folder',
      title: 'Document 文档集',
      size: 'medium',
      groupId: 'group-tools',
      x: 0,
      y: 2,
      children: [
        {
          id: 'sub-doc-pdf',
          type: 'file',
          title: '电子合同范本',
          size: 'small',
          groupId: 'group-tools',
          x: 0,
          y: 0,
          fileType: 'pdf',
          extension: 'pdf',
          createdAt: '2026-10-06',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-doc-word',
          type: 'file',
          title: '项目交接备忘',
          size: 'small',
          groupId: 'group-tools',
          x: 0,
          y: 0,
          fileType: 'doc',
          extension: 'docx',
          createdAt: '2026-10-06',
          updatedAt: '2026-10-10',
        },
      ],
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-tool-folder-util',
      type: 'folder',
      title: 'Utilities 辅助组件',
      size: 'medium',
      groupId: 'group-tools',
      x: 2,
      y: 2,
      children: [
        {
          id: 'sub-util-color',
          type: 'file',
          title: '屏幕色彩吸管',
          size: 'small',
          groupId: 'group-tools',
          x: 0,
          y: 0,
          fileType: 'exec',
          extension: 'exe',
          createdAt: '2026-10-06',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-util-clip',
          type: 'file',
          title: '剪贴板增强器',
          size: 'small',
          groupId: 'group-tools',
          x: 0,
          y: 0,
          fileType: 'exec',
          extension: 'exe',
          createdAt: '2026-10-06',
          updatedAt: '2026-10-10',
        },
      ],
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
    {
      id: 'tile-tool-folder-sys',
      type: 'folder',
      title: 'system 系统调度',
      size: 'medium',
      groupId: 'group-tools',
      x: 4,
      y: 2,
      children: [
        {
          id: 'sub-sys-perf',
          type: 'file',
          title: '进程监控与性能追踪',
          size: 'small',
          groupId: 'group-tools',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'bat',
          createdAt: '2026-10-06',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-sys-reg',
          type: 'file',
          title: '安全注册表备份',
          size: 'small',
          groupId: 'group-tools',
          x: 0,
          y: 0,
          fileType: 'data',
          extension: 'reg',
          createdAt: '2026-10-06',
          updatedAt: '2026-10-10',
        },
      ],
      createdAt: '2026-10-05',
      updatedAt: '2026-10-10',
    },
  ];
}

export const useTileStore = defineStore('tileBoard', () => {
  const groups = ref<TileGroupData[]>([]);
  const tiles = ref<TileData[]>([]);
  const wallpaper = ref<string>('/backgrounds/dark-wallpaper.png');
  const acrylicOpacity = ref<number>(0.55);
  const acrylicBlur = ref<number>(24);
  const searchQuery = ref<string>('');

  const selectedFile = ref<FileTileData | null>(null);
  const activeFolder = ref<FolderTileData | null>(null);

  const contextMenu = ref<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    tileId: null,
    groupId: null,
    isFolder: false,
  });

  const dragState = ref<DragState>({
    isDragging: false,
    tile: null,
    sourceGroupId: null,
    sourceFolderId: null,
    currentGroupId: null,
    ghostX: 0,
    ghostY: 0,
    pointerX: 0,
    pointerY: 0,
    offsetX: 0,
    offsetY: 0,
    hoverTargetTileId: null,
    hoverTargetType: null,
    hoverPhase: 'none',
    hoverConfidence: 0,
    isMergeReady: false,
    displacedPositions: {},
  });

  function loadState() {
    if (typeof localStorage === 'undefined') {
      groups.value = getDefaultGroups();
      tiles.value = getDefaultTiles();
      return;
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.groups && parsed.tiles && parsed.tiles.length > 0) {
          groups.value = parsed.groups;
          tiles.value = parsed.tiles;
          if (parsed.wallpaper) wallpaper.value = parsed.wallpaper;
          normalizeGroupOrders();
          return;
        }
      }
    } catch (e) {
      console.warn('Failed to parse stored tiles, resetting to default:', e);
    }

    groups.value = getDefaultGroups();
    tiles.value = getDefaultTiles();
    saveState();
  }

  function saveState() {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          groups: groups.value,
          tiles: tiles.value,
          wallpaper: wallpaper.value,
        }),
      );
    } catch (e) {
      console.error('Failed to save tiles state:', e);
    }
  }

  function resetToDefault() {
    groups.value = getDefaultGroups();
    tiles.value = getDefaultTiles();
    saveState();
  }

  const filteredTiles = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return tiles.value;

    return tiles.value.filter(tile => {
      if (tile.title.toLowerCase().includes(q)) return true;
      if (tile.type === 'file') {
        if (tile.description?.toLowerCase().includes(q)) return true;
        if (tile.extension?.toLowerCase().includes(q)) return true;
      } else if (tile.type === 'folder') {
        return tile.children.some(
          c => c.title.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q),
        );
      }
      return false;
    });
  });

  const tilesByGroup = computed(() => {
    const map = new Map<string, TileData[]>();
    for (const g of groups.value) {
      map.set(g.id, []);
    }
    for (const t of filteredTiles.value) {
      const list = map.get(t.groupId);
      if (list) {
        list.push(t);
      } else {
        const fallback = map.get(groups.value[0]?.id || 'group-common');
        fallback?.push(t);
      }
    }
    return map;
  });

  const columns = computed(() => {
    const colsMap = new Map<number, TileGroupData[]>();
    for (const g of groups.value) {
      const c = g.column ?? 0;
      if (!colsMap.has(c)) {
        colsMap.set(c, []);
      }
      colsMap.get(c)!.push(g);
    }
    for (const [, list] of colsMap) {
      list.sort((a, b) => a.order - b.order);
    }
    const sortedColKeys = Array.from(colsMap.keys()).sort((a, b) => a - b);
    return sortedColKeys.map(k => colsMap.get(k)!);
  });

  const groupDragState = ref<GroupDragState>({
    isDragging: false,
    groupId: null,
    targetGroupId: null,
    dropPosition: null,
    pointerX: 0,
    pointerY: 0,
  });

  /**
   * 从文件夹弹窗发起的「拖出到磁贴板」请求。
   * 弹窗内拖拽超过阈值后写入，由 TileBoard 接管为正式拖拽会话（并关闭弹窗）。
   */
  const pendingFolderChildDrag = ref<{
    file: FileTileData;
    folder: FolderTileData;
    clientX: number;
    clientY: number;
  } | null>(null);

  function beginFolderChildDrag(
    file: FileTileData,
    folder: FolderTileData,
    clientX: number,
    clientY: number,
  ) {
    // 拖出后磁贴会以 2x2 落到板上，同步预览尺寸，避免拖拽中尺寸跳变
    file.size = 'medium';
    file.customSpan = undefined;
    pendingFolderChildDrag.value = { file, folder, clientX, clientY };
  }

  function getTileById(id: string): TileData | undefined {
    return tiles.value.find(t => t.id === id);
  }

  function openFile(file: FileTileData) {
    selectedFile.value = file;
  }

  function closeFile() {
    selectedFile.value = null;
  }

  function openFolder(folder: FolderTileData) {
    activeFolder.value = folder;
  }

  function closeFolder() {
    activeFolder.value = null;
  }

  function openContextMenu(
    x: number,
    y: number,
    tile: TileData | null,
    groupId?: string,
    isBoard?: boolean,
  ) {
    contextMenu.value = {
      visible: true,
      x,
      y,
      tileId: tile ? tile.id : null,
      groupId: groupId || (tile ? tile.groupId : null),
      isFolder: tile ? tile.type === 'folder' : false,
      isBoard: isBoard ?? (!tile && !groupId),
    };
  }

  function closeContextMenu() {
    contextMenu.value.visible = false;
  }

  function resizeTile(tileId: string, size: TileSize) {
    const tile = getTileById(tileId);
    if (!tile) return;
    tile.size = size;
    delete tile.customSpan;
    const group = groups.value.find(g => g.id === tile.groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const span = getTileSpan(size);
    if (tile.x + span.w > maxCols) {
      tile.x = Math.max(0, maxCols - span.w);
    }
    tile.updatedAt = new Date().toISOString().slice(0, 10);
    saveState();
  }

  function resizeTileSpan(tileId: string, w: number, h: number) {
    const tile = getTileById(tileId);
    if (!tile) return;

    const group = groups.value.find(g => g.id === tile.groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const clampedW = Math.max(1, Math.min(maxCols - tile.x, w));
    const clampedH = Math.max(1, Math.min(6, h));

    if (clampedW === 1 && clampedH === 1) {
      tile.size = 'small';
      delete tile.customSpan;
    } else if (clampedW === 2 && clampedH === 2) {
      tile.size = 'medium';
      delete tile.customSpan;
    } else if (clampedW === 4 && clampedH === 2) {
      tile.size = 'wide';
      delete tile.customSpan;
    } else if (clampedW === 4 && clampedH === 4) {
      tile.size = 'large';
      delete tile.customSpan;
    } else {
      tile.customSpan = { w: clampedW, h: clampedH };
      if (clampedW >= 4) tile.size = 'wide';
      else if (clampedW >= 2 && clampedH >= 2) tile.size = 'medium';
      else tile.size = 'small';
    }

    tile.updatedAt = new Date().toISOString().slice(0, 10);
    saveState();
  }

  function normalizeGroupOrders() {
    // 1. Re-map column indices sequentially (0, 1, 2...) eliminating empty column gaps
    const colKeys = Array.from(new Set(groups.value.map(g => g.column ?? 0))).sort((a, b) => a - b);
    const colIndexMap = new Map<number, number>();
    colKeys.forEach((oldCol, newCol) => {
      colIndexMap.set(oldCol, newCol);
    });

    for (const g of groups.value) {
      const oldCol = g.column ?? 0;
      g.column = colIndexMap.get(oldCol) ?? 0;
    }

    // 2. Normalize orders within each column
    const colMap = new Map<number, TileGroupData[]>();
    for (const g of groups.value) {
      const c = g.column ?? 0;
      if (!colMap.has(c)) colMap.set(c, []);
      colMap.get(c)!.push(g);
    }
    for (const [, list] of colMap) {
      list.sort((a, b) => a.order - b.order);
      list.forEach((g, idx) => {
        g.order = idx;
      });
    }
  }

  function addNewGroup(title?: string, targetColumn?: number) {
    const id = `group-${Date.now()}`;
    const maxCol = Math.max(0, ...groups.value.map(g => g.column ?? 0));
    const col = targetColumn !== undefined ? targetColumn : (maxCol + 1);
    const existingInCol = groups.value.filter(g => g.column === col);
    const newOrder = existingInCol.length;

    const newGroup: TileGroupData = {
      id,
      title: title?.trim() || '新建分组',
      column: col,
      order: newOrder,
      widthColumns: 6,
    };

    groups.value.push(newGroup);
    saveState();
    return newGroup;
  }

  function deleteGroup(groupId: string) {
    const targetGroup = groups.value.find(g => g.id === groupId);
    if (!targetGroup) return;

    const remaining = groups.value.filter(g => g.id !== groupId);
    if (remaining.length === 0) {
      alert('至少需要保留一个分组');
      return;
    }

    const fallbackGroup = remaining[0];
    for (const tile of tiles.value) {
      if (tile.groupId === groupId) {
        tile.groupId = fallbackGroup.id;
      }
    }

    groups.value = remaining;
    normalizeGroupOrders();
    saveState();
  }

  function setGroupWidth(groupId: string, widthColumns: number) {
    const group = groups.value.find(g => g.id === groupId);
    if (!group) return;
    const clamped = Math.max(2, Math.min(12, widthColumns));
    group.widthColumns = clamped;
    saveState();
  }

  function reorderGroup(draggedGroupId: string, targetGroupId: string, place: 'before' | 'after') {
    if (draggedGroupId === targetGroupId) return;
    const dragged = groups.value.find(g => g.id === draggedGroupId);
    const target = groups.value.find(g => g.id === targetGroupId);
    if (!dragged || !target) return;

    dragged.column = target.column;
    const targetOrder = target.order;
    dragged.order = place === 'before' ? targetOrder - 0.5 : targetOrder + 0.5;

    normalizeGroupOrders();
    saveState();
  }

  function moveGroupToColumn(draggedGroupId: string, targetColumn: number) {
    const dragged = groups.value.find(g => g.id === draggedGroupId);
    if (!dragged) return;

    dragged.column = targetColumn;
    const existingInCol = groups.value.filter(g => g.column === targetColumn && g.id !== draggedGroupId);
    dragged.order = existingInCol.length;

    normalizeGroupOrders();
    saveState();
  }

  function moveGroupToNewColumn(draggedGroupId: string, targetColIndex?: number) {
    const dragged = groups.value.find(g => g.id === draggedGroupId);
    if (!dragged) return;

    // Collect all existing columns excluding dragged group
    const colsMap = new Map<number, TileGroupData[]>();
    for (const g of groups.value) {
      if (g.id === draggedGroupId) continue;
      const c = g.column ?? 0;
      if (!colsMap.has(c)) colsMap.set(c, []);
      colsMap.get(c)!.push(g);
    }

    const sortedCols = Array.from(colsMap.keys()).sort((a, b) => a - b);
    const targetIdx = targetColIndex !== undefined ? Math.max(0, Math.min(targetColIndex, sortedCols.length)) : sortedCols.length;

    // Build new sequential columns array
    const newColumns: TileGroupData[][] = [];
    for (let i = 0; i < sortedCols.length; i++) {
      if (i === targetIdx) {
        newColumns.push([dragged]);
      }
      newColumns.push(colsMap.get(sortedCols[i])!);
    }
    if (targetIdx >= sortedCols.length) {
      newColumns.push([dragged]);
    }

    // Re-assign column and order to all groups
    newColumns.forEach((colList, colIdx) => {
      colList.forEach((g, orderIdx) => {
        g.column = colIdx;
        g.order = orderIdx;
      });
    });

    normalizeGroupOrders();
    saveState();
  }

  function renameTile(tileId: string, newTitle: string) {
    const tile = getTileById(tileId);
    if (!tile || !newTitle.trim()) return;
    tile.title = newTitle.trim();
    tile.updatedAt = new Date().toISOString().slice(0, 10);
    saveState();
  }

  function deleteTile(tileId: string) {
    tiles.value = tiles.value.filter(t => t.id !== tileId);
    saveState();
  }

  function renameGroup(groupId: string, newTitle: string) {
    const group = groups.value.find(g => g.id === groupId);
    if (!group || !newTitle.trim()) return;
    group.title = newTitle.trim();
    saveState();
  }

  function dissolveFolder(folderId: string) {
    const folder = getTileById(folderId);
    if (!folder || folder.type !== 'folder') return;

    const files = folder.children;
    let nextX = folder.x;
    let nextY = folder.y;

    files.forEach((file, idx) => {
      file.groupId = folder.groupId;
      file.x = (nextX + (idx % 3) * 2) % GROUP_COLUMNS;
      file.y = nextY + Math.floor((idx * 2) / GROUP_COLUMNS) * 2;
      file.size = 'medium';
      tiles.value.push(file);
    });

    tiles.value = tiles.value.filter(t => t.id !== folderId);
    if (activeFolder.value?.id === folderId) {
      activeFolder.value = null;
    }
    saveState();
  }

  /**
   * 在指定分组内从 preferredY 行开始向下回绕搜索一个能容纳 span 的空位
   */
  function findNearestFreeSlot(
    groupId: string,
    span: { w: number; h: number },
    preferredY: number,
  ): { x: number; y: number } {
    const group = groups.value.find(g => g.id === groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const occupied = tiles.value
      .filter(t => t.groupId === groupId)
      .map(t => {
        const s = getTileSpan(t.size, t.customSpan);
        return { x: t.x, y: t.y, w: s.w, h: s.h };
      });

    const fits = (col: number, row: number) =>
      col >= 0 &&
      col + span.w <= maxCols &&
      occupied.every(
        o =>
          col + span.w <= o.x ||
          o.x + o.w <= col ||
          row + span.h <= o.y ||
          o.y + o.h <= row,
      );

    const TOTAL_ROWS = 200;
    for (let step = 0; step < TOTAL_ROWS; step++) {
      const row = (preferredY + step) % TOTAL_ROWS;
      for (let col = 0; col <= maxCols - span.w; col++) {
        if (fits(col, row)) return { x: col, y: row };
      }
    }
    return { x: 0, y: preferredY };
  }

  /**
   * 将文件从文件夹移回到磁贴板。
   * - 传入 targetGroupId / targetX / targetY 时落位到指定网格槽位
   * - 不传时自动在文件夹所在分组内寻找最近空位
   */
  function removeFileFromFolder(
    folderId: string,
    fileId: string,
    targetGroupId?: string,
    targetX?: number,
    targetY?: number,
  ) {
    const folder = getTileById(folderId);
    if (!folder || folder.type !== 'folder') return;

    const fileIndex = folder.children.findIndex(f => f.id === fileId);
    if (fileIndex < 0) return;

    const [file] = folder.children.splice(fileIndex, 1);
    file.groupId = targetGroupId || folder.groupId;
    file.size = 'medium';
    file.customSpan = undefined;
    file.updatedAt = new Date().toISOString().slice(0, 10);

    const group = groups.value.find(g => g.id === file.groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const span = getTileSpan(file.size, file.customSpan);

    if (targetX === undefined || targetY === undefined) {
      const slot = findNearestFreeSlot(file.groupId, span, folder.y);
      file.x = slot.x;
      file.y = slot.y;
    } else {
      file.x = Math.max(0, Math.min(targetX, maxCols - span.w));
      file.y = Math.max(0, targetY);
    }

    tiles.value.push(file);
    saveState();
  }

  function addFileToFolder(folderId: string, fileId: string) {
    const folder = getTileById(folderId);
    const file = getTileById(fileId);
    if (!folder || folder.type !== 'folder' || !file || file.type !== 'file') return;

    tiles.value = tiles.value.filter(t => t.id !== fileId);
    file.groupId = folder.groupId;
    folder.children.push(file);
    folder.updatedAt = new Date().toISOString().slice(0, 10);
    saveState();
  }

  /** 文件夹内的文件直接移入另一个文件夹 */
  function moveFileBetweenFolders(fromFolderId: string, fileId: string, toFolderId: string) {
    if (fromFolderId === toFolderId) return;
    const from = getTileById(fromFolderId);
    const to = getTileById(toFolderId);
    if (!from || from.type !== 'folder' || !to || to.type !== 'folder') return;

    const index = from.children.findIndex(f => f.id === fileId);
    if (index < 0) return;

    const [file] = from.children.splice(index, 1);
    file.groupId = to.groupId;
    to.children.push(file);
    saveState();
  }

  function createFolderFromFiles(file1Id: string, file2Id: string) {
    const file1 = getTileById(file1Id);
    const file2 = getTileById(file2Id);
    if (!file1 || file1.type !== 'file' || !file2 || file2.type !== 'file') return;

    const newFolderId = `folder-${Date.now()}`;
    const newFolder: FolderTileData = {
      id: newFolderId,
      type: 'folder',
      title: '新建文件夹',
      size: 'medium',
      groupId: file2.groupId,
      x: file2.x,
      y: file2.y,
      children: [file2, file1],
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    tiles.value = tiles.value.filter(t => t.id !== file1Id && t.id !== file2Id);
    tiles.value.push(newFolder);
    saveState();
  }

  function moveTile(tileId: string, targetGroupId: string, targetX: number, targetY: number) {
    const tile = getTileById(tileId);
    if (!tile) return;

    const group = groups.value.find(g => g.id === targetGroupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const span = getTileSpan(tile.size, tile.customSpan);
    const clampedX = Math.max(0, Math.min(targetX, maxCols - span.w));
    const clampedY = Math.max(0, targetY);

    tile.groupId = targetGroupId;
    tile.x = clampedX;
    tile.y = clampedY;
    tile.updatedAt = new Date().toISOString().slice(0, 10);
    saveState();
  }

  function addNewFile(data: Partial<FileTileData>, targetGroupId?: string) {
    const id = `file-${Date.now()}`;
    const gid = targetGroupId || groups.value[0]?.id || 'group-common';
    const newFile: FileTileData = {
      id,
      type: 'file',
      title: data.title?.trim() || '未命名文件',
      size: data.size || 'medium',
      groupId: gid,
      x: 0,
      y: 999,
      fileType: data.fileType || 'doc',
      extension: data.extension || 'txt',
      description: data.description || '',
      content: data.content || '',
      tags: data.tags || [],
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    tiles.value.push(newFile);
    saveState();
    return newFile;
  }

  function addNewFolder(title: string, targetGroupId?: string) {
    const id = `folder-${Date.now()}`;
    const gid = targetGroupId || groups.value[0]?.id || 'group-common';
    const newFolder: FolderTileData = {
      id,
      type: 'folder',
      title: title.trim() || '新文件夹',
      size: 'medium',
      groupId: gid,
      x: 0,
      y: 999,
      children: [],
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    tiles.value.push(newFolder);
    saveState();
    return newFolder;
  }

  loadState();

  return {
    groups,
    tiles,
    wallpaper,
    acrylicOpacity,
    acrylicBlur,
    searchQuery,
    selectedFile,
    activeFolder,
    contextMenu,
    dragState,
    groupDragState,
    pendingFolderChildDrag,
    beginFolderChildDrag,
    filteredTiles,
    tilesByGroup,
    columns,
    loadState,
    saveState,
    resetToDefault,
    getTileById,
    openFile,
    closeFile,
    openFolder,
    closeFolder,
    openContextMenu,
    closeContextMenu,
    resizeTile,
    resizeTileSpan,
    renameTile,
    deleteTile,
    renameGroup,
    addNewGroup,
    deleteGroup,
    setGroupWidth,
    reorderGroup,
    moveGroupToColumn,
    moveGroupToNewColumn,
    dissolveFolder,
    removeFileFromFolder,
    addFileToFolder,
    moveFileBetweenFolders,
    createFolderFromFiles,
    moveTile,
    addNewFile,
    addNewFolder,
    applyDisplacedPositions: (groupId: string, positions: Record<string, { x: number; y: number }>) => {
      const list = tiles.value.filter(t => t.groupId === groupId);
      for (const t of list) {
        if (positions[t.id]) {
          t.x = positions[t.id].x;
          t.y = positions[t.id].y;
        }
      }
      saveState();
    },
  };
});
