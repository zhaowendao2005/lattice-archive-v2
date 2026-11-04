import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { isMockDev } from '@/config/env';
import { coverImageBus } from '@/stores/app/data-sources/coverImageBus';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import { opfsExploreStorage } from '@/stores/archive/data-sources/opfsExploreStorage';
import { storageQuotaEvictor } from '@/stores/archive/data-sources/storageQuotaEvictor';
import { telegramBusClient } from '@/stores/telegram/data-sources/telegramBusClient';
import { coverSizeOf, videoPreviewOf } from '@/stores/chat/stores/chatModel';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { mediaTarget } from '@/stores/chat/stores/chatModel';
import { classifyTelegramError } from '@/worker/local/chat/telegramErrors';
import { attachCanonicalResource, materializeResourceMirrors, migrateExploreManifestV2ToV3, stripResourceMirrors } from '../utils/resourceManifest';
import type { TgMediaFile, TgPeerKey, TgPeerRef } from '@/stores/chat/types';
import type {
  AggregateSearchResultItem,
  ExploreManifestV2,
  SharedVaultGroupConfig,
  TempSessionCredential,
} from '@/stores/archive/types';
import type {
  ContextMenuState,
  DragState,
  FileTileData,
  FolderTileData,
  GroupDragState,
  TileData,
  TileGroupData,
  TileSize,
} from '@/views/main/archive/types/tile';

export const SYSTEM_SEARCH_TILE_ID = 'tile-system-search';
export const SYSTEM_SESSION_MANAGER_TILE_ID = 'tile-system-session-manager';

function createSystemSearchTile(groupId = 'group-common', x = 0, y = 4): FileTileData {
  return {
    id: SYSTEM_SEARCH_TILE_ID,
    type: 'file',
    title: '聚合搜索',
    size: 'medium',
    groupId,
    x,
    y,
    fileType: 'exec',
    extension: 'SEARCH',
    description: '跨会话多源流式聚合检索与磁贴拓扑归档系统',
    systemApp: 'aggregate-search',
    undeletable: true,
    updatedAtMs: Date.now(),
    createdAt: '2026-10-01',
    updatedAt: '2026-11-01',
  };
}

function createSystemSessionManagerTile(groupId = 'group-common', x = 2, y = 4): FileTileData {
  return {
    id: SYSTEM_SESSION_MANAGER_TILE_ID,
    type: 'file',
    title: '会话管理中心',
    size: 'medium',
    groupId,
    x,
    y,
    fileType: 'exec',
    extension: 'SESSIONS',
    description: '已加入与临时凭据会话池、多账号槽位矩阵、智能配额与存储子域治理中心',
    systemApp: 'session-manager',
    undeletable: true,
    updatedAtMs: Date.now(),
    createdAt: '2026-10-01',
    updatedAt: '2026-11-01',
  };
}

const STORAGE_KEY = isMockDev
  ? 'lattice_archive_tiles_mock_v2'
  : 'lattice_archive_tiles_real_v2';

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
    createSystemSearchTile('group-common', 0, 4),

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
          title: 'Lattice 核心研发讨论',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'doc',
          extension: 'session',
          sessionId: 'session-joined-1',
          sessionTitle: 'Lattice 核心研发架构讨论',
          isSessionLink: true,
          description: '内部核心协议与双向同步研发群',
          createdAt: '2026-10-08',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-chat-2',
          type: 'file',
          title: 'Telegram 协议研讨',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'code',
          extension: 'session',
          sessionId: 'session-joined-2',
          sessionTitle: 'Telegram MTProto 协议中文讨论组',
          isSessionLink: true,
          description: 'MTProto 2.0 传输层性能调优讨论',
          createdAt: '2026-10-08',
          updatedAt: '2026-10-10',
        },
        {
          id: 'sub-chat-3',
          type: 'file',
          title: 'Cloudflare Workers 研发群',
          size: 'small',
          groupId: 'group-work',
          x: 0,
          y: 0,
          fileType: 'data',
          extension: 'session',
          sessionId: 'session-joined-3',
          sessionTitle: 'Cloudflare Workers & D1 研发群',
          isSessionLink: true,
          description: '边缘计算与 D1 数据库存储架构',
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

/**
 * 递归统计文件夹内包含的所有文件与子文件夹总数
 */
export function countFolderItemsRecursive(folder: FolderTileData): number {
  let count = 0;
  for (const child of folder.children) {
    count += 1;
    if (child.type === 'folder') {
      count += countFolderItemsRecursive(child);
    }
  }
  return count;
}

export const useTileStore = defineStore('tileBoard', () => {
  const groups = ref<TileGroupData[]>([]);
  const tiles = ref<TileData[]>([]);
  const tombstones = ref<Record<string, number>>({});
  const resources = ref<NonNullable<ExploreManifestV2['resources']>>({});
  const tempCredentials = ref<TempSessionCredential[]>([]);
  const vaultConfig = ref<SharedVaultGroupConfig>({
    enabled: false,
    vaultPeerKey: '',
    vaultTitle: 'Lattice 跨账号私密归档保险库',
    ownerAccountId: '',
    memberAccountIds: [],
    topics: {
      video: 0,
      photo: 0,
      document: 0,
      beacon: 0,
      manifest: 0,
    },
  });

  const revision = ref<number>(1);
  const updatedAtMs = ref<number>(Date.now());
  const isDirty = ref<boolean>(false);

  const wallpaper = ref<string>('/backgrounds/dark-wallpaper.png');
  const acrylicOpacity = ref<number>(0.55);
  const acrylicBlur = ref<number>(24);
  const searchQuery = ref<string>('');

  const selectedFile = ref<FileTileData | null>(null);
  const activeFolder = ref<FolderTileData | null>(null);
  /** 文件夹弹窗的面包屑路径栈（支持无限层级下钻与回退） */
  const folderPathStack = ref<FolderTileData[]>([]);

  /**
   * 视图零本地 ref 支撑状态：
   * 1. 分组标题编辑与列宽拖拽状态 (TileGroupContainer.vue)
   * 2. 磁贴右下角尺寸拖拽状态 (BaseTile.vue)
   * 3. 文件夹弹窗标题编辑状态 (TileFolderModal.vue)
   * 4. 文件详情弹窗编辑状态 (FileDetailModal.vue)
   */
  const editingGroupId = ref<string | null>(null);
  const editingGroupTitleDraft = ref<string>('');
  const resizingGroupWidthId = ref<string | null>(null);
  const resizingGroupLiveCols = ref<number>(6);

  const resizingTileId = ref<string | null>(null);
  const resizingTileSpan = ref<{ w: number; h: number } | null>(null);

  const isEditingFolderModalTitle = ref<boolean>(false);
  const folderModalTitleDraft = ref<string>('');

  const isEditingFileDetail = ref<boolean>(false);
  const fileDetailTitleDraft = ref<string>('');
  const fileDetailDescDraft = ref<string>('');

  /** 批量框选与多选磁贴 ID 集合 */
  const selectedTileIds = ref<string[]>([]);

  /** 文件夹弹窗内部选中与框选状态 */
  const folderSelectedTileIds = ref<string[]>([]);
  const folderMarqueeState = ref<{
    isSelecting: boolean;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    additive: boolean;
    baseSelectedIds: string[];
  }>({
    isSelecting: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    additive: false,
    baseSelectedIds: [],
  });

  /** 正在刷新或重新加载封面的磁贴状态与结果提示 */
  const isRefreshingTileCovers = ref<boolean>(false);
  const coverRefreshBannerText = ref<string | null>(null);

  /** Windows 风格框选 (Rubber-band Marquee Selection) 状态 */
  const marqueeState = ref<{
    isSelecting: boolean;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    additive: boolean;
    baseSelectedIds: string[];
  }>({
    isSelecting: false,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    additive: false,
    baseSelectedIds: [],
  });

  /** 通用资源管理器 / Finder 目录选择与路径管理状态 */
  const explorerPickerState = ref<{
    isOpen: boolean;
    mode: 'move-tiles' | 'select-target';
    tileIds: string[];
    selectedTargetType: 'group' | 'folder';
    selectedTargetId: string;
    creatingFolderInTargetId: string | null;
    newFolderDraft: string;
  }>({
    isOpen: false,
    mode: 'move-tiles',
    tileIds: [],
    selectedTargetType: 'group',
    selectedTargetId: 'group-common',
    creatingFolderInTargetId: null,
    newFolderDraft: '',
  });

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

  let opfsPersistTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 递归在树中查找任意深度的磁贴（顶层或任意嵌套文件夹内）
   */
  function findTileInList(list: TileData[], id: string): TileData | undefined {
    for (const item of list) {
      if (item.id === id) return item;
      if (item.type === 'folder') {
        const found = findTileInList(item.children, id);
        if (found) return found;
      }
    }
    return undefined;
  }

  function getTileById(id: string): TileData | undefined {
    return findTileInList(tiles.value, id);
  }

  /**
   * 递归查找某个磁贴所在的直接父文件夹（若在顶层则返回 undefined）
   */
  function findParentFolderOfTile(
    targetId: string,
    list: TileData[] = tiles.value,
  ): FolderTileData | undefined {
    for (const item of list) {
      if (item.type === 'folder') {
        if (item.children.some((c) => c.id === targetId)) {
          return item;
        }
        const deepParent = findParentFolderOfTile(targetId, item.children);
        if (deepParent) return deepParent;
      }
    }
    return undefined;
  }

  /**
   * 检查 candidateId 是否为 folder 的子孙节点（防止文件夹拖入自身或自身后代形成环）
   */
  function isDescendantOfFolder(folder: FolderTileData, candidateId: string): boolean {
    if (folder.id === candidateId) return true;
    for (const child of folder.children) {
      if (child.id === candidateId) return true;
      if (child.type === 'folder' && isDescendantOfFolder(child, candidateId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 计算指定文件夹从根文件夹到自身的完整面包屑路径
   */
  function computeFolderPathStack(folderId: string): FolderTileData[] {
    const stack: FolderTileData[] = [];
    let current = getTileById(folderId);
    while (current && current.type === 'folder') {
      stack.unshift(current);
      const parent = findParentFolderOfTile(current.id);
      current = parent;
    }
    return stack;
  }

  function collectAllResourceIds(list: TileData[] = tiles.value, out = new Set<string>()): Set<string> {
    for (const item of list) {
      if (item.type === 'folder') collectAllResourceIds(item.children, out);
      else if (item.resourceId) out.add(item.resourceId);
    }
    return out;
  }

  /**
   * 确保两大系统级常驻磁贴（聚合搜索 + 会话管理中心）始终存在且不可删除
   */
  function ensureSystemTiles(): boolean {
    let changed = false;
    const targetGroupId = groups.value[0]?.id || 'group-common';

    const existingSearch = findTileInList(tiles.value, SYSTEM_SEARCH_TILE_ID) ||
      tiles.value.find((t) => t.systemApp === 'aggregate-search');
    if (existingSearch) {
      existingSearch.systemApp = 'aggregate-search';
      existingSearch.undeletable = true;
    } else {
      const slot = findNearestFreeSlot(targetGroupId, { w: 2, h: 2 }, 0);
      tiles.value.push(createSystemSearchTile(targetGroupId, slot.x, slot.y));
      changed = true;
    }

    const existingSessionMgr = findTileInList(tiles.value, SYSTEM_SESSION_MANAGER_TILE_ID) ||
      tiles.value.find((t) => t.systemApp === 'session-manager');
    if (existingSessionMgr) {
      existingSessionMgr.systemApp = 'session-manager';
      existingSessionMgr.undeletable = true;
    } else {
      const slot = findNearestFreeSlot(targetGroupId, { w: 2, h: 2 }, 0);
      tiles.value.push(createSystemSessionManagerTile(targetGroupId, slot.x, slot.y));
      changed = true;
    }

    return changed;
  }

  function stripTransientBlobUrls(list: TileData[]): TileData[] {
    const cloned = JSON.parse(JSON.stringify(list)) as TileData[];
    const walk = (items: TileData[]) => {
      for (const item of items) {
        if (item.thumb?.objectUrl?.startsWith('blob:')) {
          delete item.thumb.objectUrl;
        }
        if (item.type === 'folder' && Array.isArray(item.children)) {
          walk(item.children);
        }
      }
    };
    walk(cloned);
    return cloned;
  }

  /**
   * 构造当前 Explore VFS 完整 Manifest 快照（深拷贝为纯 JSON，剥离响应式 Proxy 与临时 blob: URL）
   */
  function buildExploreManifest(): ExploreManifestV2 {
    return stripResourceMirrors({
      schemaVersion: 3,
      revision: revision.value,
      updatedAtMs: updatedAtMs.value,
      deviceId: opfsExploreStorage.getOrCreateDeviceId(),
      groups: JSON.parse(JSON.stringify(groups.value)),
      tiles: stripTransientBlobUrls(tiles.value),
      resources: JSON.parse(JSON.stringify(resources.value)),
      tombstones: JSON.parse(JSON.stringify(tombstones.value)),
      tempCredentials: JSON.parse(JSON.stringify(tempCredentials.value)),
      vaultConfig: JSON.parse(JSON.stringify(vaultConfig.value)),
    });
  }

  /**
   * 应用外部（OPFS / 冷备导入 / 云端 CRDT 合并后）的 Manifest 快照并立即持久化至本地存储
   */
  function applyExploreManifest(manifest: ExploreManifestV2, markClean = false): void {
    groups.value = manifest.groups && manifest.groups.length > 0
      ? JSON.parse(JSON.stringify(manifest.groups))
      : getDefaultGroups();
    const migrated = materializeResourceMirrors(migrateExploreManifestV2ToV3(manifest));
    tiles.value = Array.isArray(migrated.tiles)
      ? stripTransientBlobUrls(migrated.tiles)
      : [];
    resources.value = migrated.resources ?? {};
    tombstones.value = manifest.tombstones ? { ...manifest.tombstones } : {};
    tempCredentials.value = Array.isArray(manifest.tempCredentials)
      ? JSON.parse(JSON.stringify(manifest.tempCredentials))
      : [];
    if (manifest.vaultConfig) {
      vaultConfig.value = JSON.parse(JSON.stringify(manifest.vaultConfig));
    }
    revision.value = manifest.revision || 1;
    updatedAtMs.value = manifest.updatedAtMs || Date.now();
    normalizeGroupOrders();
    ensureSystemTiles();
    saveState(false);
    if (markClean) {
      isDirty.value = false;
    }
    void hydrateAllThumbnails();
  }

  /**
   * 异步水合所有带 opfsPath 的磁贴缩略图 ObjectURL
   */
  async function hydrateAllThumbnails(list: TileData[] = tiles.value): Promise<void> {
    for (const item of list) {
      if (item.thumb?.opfsPath && item.thumb.status === 'ready') {
        const resourceId = item.type === 'file' ? item.resourceId : undefined;
        let url = await opfsExploreStorage.readThumbnailObjectUrl(resourceId ?? item.id);
        if (!url && resourceId) {
          const legacyBytes = await opfsExploreStorage.readThumbnailBytes(item.id);
          if (legacyBytes) {
            const migrated = await opfsExploreStorage.writeThumbnail(resourceId, legacyBytes);
            url = migrated.objectUrl;
            item.thumb = { ...item.thumb, opfsPath: migrated.opfsPath };
          }
        }
        if (url) item.thumb.objectUrl = url;
      }
      if (item.type === 'folder') {
        await hydrateAllThumbnails(item.children);
      }
    }
  }

  /**
   * 保存并写入磁贴高清缩略图至 OPFS `/thumbs/{tileId}.webp`
   */
  function findTilesByResourceId(resourceId: string): FileTileData[] {
    const found: FileTileData[] = [];
    const walk = (list: TileData[]) => {
      for (const item of list) {
        if (item.type === 'folder') walk(item.children);
        else if (item.resourceId === resourceId) found.push(item);
      }
    };
    walk(tiles.value);
    return found;
  }

  async function saveTileThumbnail(
    tileId: string,
    bytes: Uint8Array,
    strippedDataUrl?: string,
  ): Promise<void> {
    const tile = getTileById(tileId);
    if (!tile) {
      logCover('tile_thumb_persist_error', 'WARN', { tileId, reason: 'TILE_NOT_FOUND' }, '磁贴不存在，缩略图未落盘');
      return;
    }
    const resourceId = tile.type === 'file' ? tile.resourceId ?? tileId : tileId;
    try {
      const { opfsPath, objectUrl } = await opfsExploreStorage.writeThumbnail(resourceId, bytes);
      const thumb = {
        ...(tile.thumb ?? { retryCount: 0 }),
        status: 'ready' as const,
        opfsPath,
        objectUrl,
        strippedDataUrl: strippedDataUrl ?? tile.thumb?.strippedDataUrl,
      };
      tile.thumb = thumb;
      for (const instance of findTilesByResourceId(resourceId)) instance.thumb = { ...thumb };
      const resource = resources.value[resourceId];
      if (resource) {
        resource.thumb = { status: 'ready', strippedDataUrl: thumb.strippedDataUrl, retryCount: thumb.retryCount };
        resource.updatedAtMs = Date.now();
      }
      saveState();
    } catch (error) {
      const info = classifyTelegramError(error);
      logCover(
        'tile_thumb_persist_error',
        'ERROR',
        { tileId, bucket: info.bucket, code: info.code, bytes: bytes.byteLength },
        info.description,
      );
      // 兜底：本次会话仍用内存 ObjectURL 展示，下次启动会重新拉取
      try {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        const objectUrl = URL.createObjectURL(new Blob([copy.buffer], { type: 'image/jpeg' }));
        tile.thumb = {
          ...(tile.thumb ?? { retryCount: 0 }),
          status: 'ready',
          objectUrl,
          strippedDataUrl: strippedDataUrl ?? tile.thumb?.strippedDataUrl,
        };
        saveState();
      } catch {
        // 内存兜底也失败时保持原状，由重试队列处理
      }
    }
  }

  /**
   * 失败缩略图自动自愈重取队列
   */
  async function retryFailedThumbnails(
    fetcher?: (tile: TileData) => Promise<Uint8Array | null>,
  ): Promise<number> {
    let recovered = 0;
    const now = Date.now();
    const visit = async (list: TileData[]) => {
      for (const item of list) {
        if (
          item.thumb &&
          (item.thumb.status === 'failed' || item.thumb.status === 'pending') &&
          item.thumb.retryCount < 5 &&
          (!item.thumb.nextRetryAt || item.thumb.nextRetryAt <= now)
        ) {
          if (fetcher) {
            try {
              const bytes = await fetcher(item);
              if (bytes && bytes.byteLength > 0) {
                await saveTileThumbnail(item.id, bytes, item.thumb.strippedDataUrl);
                recovered += 1;
              } else {
                item.thumb.retryCount += 1;
                item.thumb.nextRetryAt = now + Math.min(60_000, 2000 * 2 ** item.thumb.retryCount);
              }
            } catch {
              item.thumb.status = 'failed';
              item.thumb.retryCount += 1;
              item.thumb.nextRetryAt = now + Math.min(60_000, 2000 * 2 ** item.thumb.retryCount);
            }
          }
        }
        if (item.type === 'folder') {
          await visit(item.children);
        }
      }
    };
    await visit(tiles.value);
    if (recovered > 0) saveState();
    return recovered;
  }

  function loadState() {
    if (typeof localStorage === 'undefined') {
      groups.value = getDefaultGroups();
      tiles.value = isMockDev ? getDefaultTiles() : [];
      ensureSystemTiles();
      return;
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.groups && Array.isArray(parsed.tiles)) {
          const migrated = materializeResourceMirrors(migrateExploreManifestV2ToV3(parsed as ExploreManifestV2));
          groups.value = migrated.groups;
          tiles.value = migrated.tiles;
          resources.value = migrated.resources ?? {};
          if (parsed.tombstones) tombstones.value = parsed.tombstones;
          if (parsed.tempCredentials) tempCredentials.value = parsed.tempCredentials;
          if (parsed.vaultConfig) vaultConfig.value = parsed.vaultConfig;
          if (parsed.revision) revision.value = parsed.revision;
          if (typeof parsed.updatedAtMs === 'number') updatedAtMs.value = parsed.updatedAtMs;
          if (parsed.wallpaper) wallpaper.value = parsed.wallpaper;
          normalizeGroupOrders();
          ensureSystemTiles();
          void hydrateAllThumbnails();
          if ((parsed.schemaVersion ?? 2) < 3) saveState(false);
        }
      } else {
        // 首次启动：根据硬环境隔离策略初始化
        // dev-mock 加载完整演示磁贴；dev-real / prod 仅创建干净分组与两大常驻系统磁贴
        // 初始 updatedAtMs 置为 0，确保新设备首次云同步时不会覆盖云端已有数据
        groups.value = getDefaultGroups();
        tiles.value = isMockDev ? getDefaultTiles() : [];
        revision.value = 1;
        updatedAtMs.value = 0;
        ensureSystemTiles();
        saveState(false);
      }
    } catch (e) {
      console.warn('Failed to parse stored tiles, resetting to default:', e);
      groups.value = getDefaultGroups();
      tiles.value = isMockDev ? getDefaultTiles() : [];
      ensureSystemTiles();
      saveState();
    }

    // 异步从 OPFS 读取最新 manifest（若 OPFS 版本更新则覆盖）
    void (async () => {
      const opfsManifest = await opfsExploreStorage.readManifest();
      if (opfsManifest && opfsManifest.revision >= revision.value && opfsManifest.tiles?.length > 0) {
        // 在真实模式下或 OPFS 版本更高时采用 OPFS 快照
        if (!isMockDev || opfsManifest.revision > revision.value) {
          applyExploreManifest(opfsManifest, false);
        }
      } else {
        await opfsExploreStorage.writeManifest(buildExploreManifest());
      }
      await storageQuotaEvictor.runMaintenanceAndEviction(collectAllResourceIds());
    })();
  }

  function pruneOrphanResources() {
    const referenced = collectAllResourceIds();
    for (const id of Object.keys(resources.value)) {
      if (referenced.has(id)) continue;
      tombstones.value[`resource:${id}`] = Math.max(tombstones.value[`resource:${id}`] ?? 0, Date.now());
      delete resources.value[id];
    }
  }

  function saveState(bumpRevision = true) {
    pruneOrphanResources();
    if (bumpRevision) {
      revision.value += 1;
      updatedAtMs.value = Date.now();
      isDirty.value = true;
    }

    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({
            schemaVersion: 3,
            groups: groups.value,
            tiles: buildExploreManifest().tiles,
            resources: resources.value,
            tombstones: tombstones.value,
            tempCredentials: tempCredentials.value,
            vaultConfig: vaultConfig.value,
            revision: revision.value,
            updatedAtMs: updatedAtMs.value,
            wallpaper: wallpaper.value,
          }),
        );
      } catch (e) {
        const info = classifyTelegramError(e);
        debugLoggerDataSource.emitFrontendLog({
          domain: 'archive.storage',
          action: 'local_storage_save_error',
          level: 'ERROR',
          message: info.description,
          tags: {
            bucket: info.bucket,
            code: info.code,
            retryable: info.retryable,
            tiles: tiles.value.length,
            bytes: JSON.stringify(tiles.value).length,
          },
        });
        console.error('Failed to save tiles state to localStorage:', e);
      }
    }

    if (opfsPersistTimer) {
      clearTimeout(opfsPersistTimer);
    }
    opfsPersistTimer = setTimeout(() => {
      void opfsExploreStorage.writeManifest(buildExploreManifest());
    }, 300);
  }

  function resetToDefault() {
    groups.value = getDefaultGroups();
    tiles.value = isMockDev ? getDefaultTiles() : [];
    tombstones.value = {};
    resources.value = {};
    ensureSystemTiles();
    saveState();
  }

  /**
   * 导出 `.lattice-archive` 完整冷备文件并触发浏览器下载
   */
  async function exportColdArchive(): Promise<void> {
    const manifest = buildExploreManifest();
    const allIds = Array.from(collectAllResourceIds());
    const blob = await opfsExploreStorage.exportColdBackupArchive(manifest, allIds);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const dateStr = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `explore-backup-${dateStr}.lattice-archive`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 从用户选择的 `.lattice-archive` 文件恢复磁贴树与缩略图
   */
  async function importColdArchive(file: File): Promise<void> {
    const manifest = await opfsExploreStorage.importColdBackupArchive(file);
    applyExploreManifest(manifest, false);
    saveState();
  }

  function tileMatchesSearchRecursive(tile: TileData, q: string): boolean {
    if (tile.title.toLowerCase().includes(q)) return true;
    if (tile.type === 'file') {
      if (tile.description?.toLowerCase().includes(q)) return true;
      if (tile.extension?.toLowerCase().includes(q)) return true;
      if (tile.username?.toLowerCase().includes(q)) return true;
    } else if (tile.type === 'folder') {
      return tile.children.some((c) => tileMatchesSearchRecursive(c, q));
    }
    return false;
  }

  const filteredTiles = computed(() => {
    const q = searchQuery.value.trim().toLowerCase();
    if (!q) return tiles.value;
    return tiles.value.filter((tile) => tileMatchesSearchRecursive(tile, q));
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
    return sortedColKeys.map((k) => colsMap.get(k)!);
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
   */
  const pendingFolderChildDrag = ref<{
    file: TileData;
    folder: FolderTileData;
    clientX: number;
    clientY: number;
  } | null>(null);

  function beginFolderChildDrag(
    file: TileData,
    folder: FolderTileData,
    clientX: number,
    clientY: number,
  ) {
    file.size = 'medium';
    file.customSpan = undefined;
    pendingFolderChildDrag.value = { file, folder, clientX, clientY };
  }

  async function openTelegramMedia(tile: FileTileData): Promise<boolean> {
    const source = tile.sources?.[0] ?? resources.value[tile.resourceId ?? '']?.sources?.[0];
    const resource = resources.value[tile.resourceId ?? ''];
    const sourceRef = tile.thumb?.sourceRef;
    const peerKey = (tile.peerKey ?? source?.peerKey ?? resource?.peerKey ?? (sourceRef ? `${sourceRef.peerType ?? 'channel'}-${sourceRef.peerId}` : undefined)) as TgPeerKey | undefined;
    const messageId = source?.msgId ?? resource?.messageId ?? sourceRef?.msgId;
    const accountId = tile.accountId ?? source?.accountId ?? resource?.accountId ?? sourceRef?.accountId;
    if (!peerKey || !messageId || !accountId) {
      openFile(tile);
      return false;
    }
    try {
      const chatStore = useChatStore();
      await chatStore.openSessionFromTile({
        peerKey,
        peerType: tile.peerType ?? source?.peerType ?? resource?.peerType ?? sourceRef?.peerType,
        accessHash: tile.accessHash ?? source?.accessHash ?? resource?.accessHash ?? sourceRef?.accessHash,
        title: tile.sessionTitle || tile.title,
        username: tile.username ?? resource?.username,
        inviteHash: tile.inviteHash ?? resource?.inviteHash,
        accountId,
        messageId,
      });
      const message = chatStore.windows[peerKey]?.messages.find((item) => item.id === messageId);
      if (!message?.media) {
        openFile(tile);
        return false;
      }
      useChatMediaStore().openViewer(mediaTarget(peerKey, messageId), true);
      return true;
    } catch (error) {
      logCover('tile_media_open_error', 'WARN', { tileId: tile.id, resourceId: tile.resourceId }, error instanceof Error ? error.message : '媒体打开失败');
      openFile(tile);
      return false;
    }
  }

  function openFile(file: FileTileData) {
    selectedFile.value = file;
    isEditingFileDetail.value = false;
  }

  function closeFile() {
    selectedFile.value = null;
    isEditingFileDetail.value = false;
  }

  function openFolder(folder: FolderTileData) {
    activeFolder.value = folder;
    folderPathStack.value = computeFolderPathStack(folder.id);
    isEditingFolderModalTitle.value = false;
    folderSelectedTileIds.value = [];
  }

  function navigateToBreadcrumbFolder(folderId: string) {
    const target = getTileById(folderId);
    if (target && target.type === 'folder') {
      activeFolder.value = target;
      folderPathStack.value = computeFolderPathStack(target.id);
      isEditingFolderModalTitle.value = false;
      folderSelectedTileIds.value = [];
    }
  }

  function closeFolder() {
    activeFolder.value = null;
    folderPathStack.value = [];
    isEditingFolderModalTitle.value = false;
    folderSelectedTileIds.value = [];
  }

  function openContextMenu(
    x: number,
    y: number,
    tile: TileData | null,
    groupId?: string,
    isBoard?: boolean,
    folderId?: string | null,
  ) {
    contextMenu.value = {
      visible: true,
      x,
      y,
      tileId: tile ? tile.id : null,
      groupId: groupId || (tile ? tile.groupId : null),
      folderId: folderId ?? (tile?.parentId ?? null),
      isFolder: tile ? tile.type === 'folder' : false,
      isBoard: isBoard ?? (!tile && !groupId && !folderId),
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
    const group = groups.value.find((g) => g.id === tile.groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const span = getTileSpan(size);
    if (tile.x + span.w > maxCols) {
      tile.x = Math.max(0, maxCols - span.w);
    }
    tile.updatedAt = new Date().toISOString().slice(0, 10);
    tile.updatedAtMs = Date.now();
    saveState();
  }

  function resizeTileSpan(tileId: string, w: number, h: number) {
    const tile = getTileById(tileId);
    if (!tile) return;

    const group = groups.value.find((g) => g.id === tile.groupId);
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
    tile.updatedAtMs = Date.now();
    saveState();
  }

  function normalizeGroupOrders() {
    const colKeys = Array.from(new Set(groups.value.map((g) => g.column ?? 0))).sort((a, b) => a - b);
    const colIndexMap = new Map<number, number>();
    colKeys.forEach((oldCol, newCol) => {
      colIndexMap.set(oldCol, newCol);
    });

    for (const g of groups.value) {
      const oldCol = g.column ?? 0;
      g.column = colIndexMap.get(oldCol) ?? 0;
    }

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
    const maxCol = Math.max(0, ...groups.value.map((g) => g.column ?? 0));
    const col = targetColumn !== undefined ? targetColumn : maxCol + 1;
    const existingInCol = groups.value.filter((g) => g.column === col);
    const newOrder = existingInCol.length;

    const newGroup: TileGroupData = {
      id,
      title: title?.trim() || '新建分组',
      column: col,
      order: newOrder,
      widthColumns: 6,
      updatedAtMs: Date.now(),
    };

    groups.value.push(newGroup);
    saveState();
    return newGroup;
  }

  function deleteGroup(groupId: string) {
    const targetGroup = groups.value.find((g) => g.id === groupId);
    if (!targetGroup) return;

    const remaining = groups.value.filter((g) => g.id !== groupId);
    if (remaining.length === 0) {
      return;
    }

    const fallbackGroup = remaining[0]!;
    for (const tile of tiles.value) {
      if (tile.groupId === groupId) {
        tile.groupId = fallbackGroup.id;
      }
    }

    tombstones.value[groupId] = Date.now();
    groups.value = remaining;
    normalizeGroupOrders();
    saveState();
  }

  function setGroupWidth(groupId: string, widthColumns: number) {
    const group = groups.value.find((g) => g.id === groupId);
    if (!group) return;
    const clamped = Math.max(2, Math.min(12, widthColumns));
    group.widthColumns = clamped;
    group.updatedAtMs = Date.now();
    saveState();
  }

  function reorderGroup(draggedGroupId: string, targetGroupId: string, place: 'before' | 'after') {
    if (draggedGroupId === targetGroupId) return;
    const dragged = groups.value.find((g) => g.id === draggedGroupId);
    const target = groups.value.find((g) => g.id === targetGroupId);
    if (!dragged || !target) return;

    dragged.column = target.column;
    const targetOrder = target.order;
    dragged.order = place === 'before' ? targetOrder - 0.5 : targetOrder + 0.5;
    dragged.updatedAtMs = Date.now();

    normalizeGroupOrders();
    saveState();
  }

  function moveGroupToColumn(draggedGroupId: string, targetColumn: number) {
    const dragged = groups.value.find((g) => g.id === draggedGroupId);
    if (!dragged) return;

    dragged.column = targetColumn;
    const existingInCol = groups.value.filter((g) => g.column === targetColumn && g.id !== draggedGroupId);
    dragged.order = existingInCol.length;
    dragged.updatedAtMs = Date.now();

    normalizeGroupOrders();
    saveState();
  }

  function moveGroupToNewColumn(draggedGroupId: string, targetColIndex?: number) {
    const dragged = groups.value.find((g) => g.id === draggedGroupId);
    if (!dragged) return;

    const colsMap = new Map<number, TileGroupData[]>();
    for (const g of groups.value) {
      if (g.id === draggedGroupId) continue;
      const c = g.column ?? 0;
      if (!colsMap.has(c)) colsMap.set(c, []);
      colsMap.get(c)!.push(g);
    }

    const sortedCols = Array.from(colsMap.keys()).sort((a, b) => a - b);
    const targetIdx =
      targetColIndex !== undefined
        ? Math.max(0, Math.min(targetColIndex, sortedCols.length))
        : sortedCols.length;

    const newColumns: TileGroupData[][] = [];
    for (let i = 0; i < sortedCols.length; i++) {
      if (i === targetIdx) {
        newColumns.push([dragged]);
      }
      newColumns.push(colsMap.get(sortedCols[i]!)!);
    }
    if (targetIdx >= sortedCols.length) {
      newColumns.push([dragged]);
    }

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
    tile.updatedAtMs = Date.now();
    saveState();
  }

  /**
   * 递归从任意层级删除磁贴，并记录 Tombstone 与回收 OPFS 缩略图
   */
  function deleteTile(tileId: string) {
    const target = getTileById(tileId);
    if (!target || target.undeletable || target.systemApp) return;

    const now = Date.now();
    const recordTombstones = (item: TileData) => {
      tombstones.value[item.id] = now;
      void opfsExploreStorage.deleteThumbnail(item.id);
      if (item.type === 'folder') {
        item.children.forEach(recordTombstones);
      }
    };
    recordTombstones(target);

    const parentFolder = findParentFolderOfTile(tileId);
    if (parentFolder) {
      parentFolder.children = parentFolder.children.filter((c) => c.id !== tileId);
      parentFolder.updatedAt = new Date().toISOString().slice(0, 10);
      parentFolder.updatedAtMs = now;
    } else {
      tiles.value = tiles.value.filter((t) => t.id !== tileId);
    }

    if (activeFolder.value?.id === tileId) {
      closeFolder();
    }
    saveState();
  }

  function renameChildFile(folderId: string, fileId: string, newTitle: string) {
    const folder = getTileById(folderId);
    if (!folder || folder.type !== 'folder' || !newTitle.trim()) return;
    const child = folder.children.find((f) => f.id === fileId);
    if (!child) return;
    child.title = newTitle.trim();
    child.updatedAt = new Date().toISOString().slice(0, 10);
    child.updatedAtMs = Date.now();
    saveState();
  }

  function deleteChildFile(_folderId: string, fileId: string) {
    deleteTile(fileId);
  }

  function upgradeSessionTileCredential(
    peerKeyOrSessionId: string,
    newState: 'joined' | 'temp_ephemeral' | 'temp_auto_renew',
  ) {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const updateList = (list: TileData[]) => {
      for (const item of list) {
        if (item.type === 'file') {
          if (
            item.peerKey === peerKeyOrSessionId ||
            item.sessionId === peerKeyOrSessionId ||
            item.id === peerKeyOrSessionId
          ) {
            item.sessionCredentialState = newState;
            item.updatedAt = today;
            item.updatedAtMs = now;
          }
        } else if (item.type === 'folder') {
          updateList(item.children);
        }
      }
    };
    updateList(tiles.value);
    saveState();
  }

  function togglePinOfflineAsset(tileId: string) {
    const tile = getTileById(tileId);
    if (!tile || tile.type !== 'file') return;
    tile.pinnedOffline = !tile.pinnedOffline;
    tile.updatedAt = new Date().toISOString().slice(0, 10);
    tile.updatedAtMs = Date.now();
    saveState();
  }

  function renameGroup(groupId: string, newTitle: string) {
    const group = groups.value.find((g) => g.id === groupId);
    if (!group || !newTitle.trim()) return;
    group.title = newTitle.trim();
    group.updatedAtMs = Date.now();
    saveState();
  }

  function dissolveFolder(folderId: string) {
    const folder = getTileById(folderId);
    if (!folder || folder.type !== 'folder') return;

    const parentFolder = findParentFolderOfTile(folderId);
    const children = [...folder.children];

    if (parentFolder) {
      // 若为嵌套子文件夹，解散后将其子项提升至父文件夹中
      parentFolder.children = parentFolder.children.filter((c) => c.id !== folderId);
      for (const item of children) {
        item.parentId = parentFolder.id;
        parentFolder.children.push(item);
      }
      parentFolder.updatedAtMs = Date.now();
      if (activeFolder.value?.id === folderId) {
        openFolder(parentFolder);
      }
    } else {
      const nextX = folder.x;
      const nextY = folder.y;
      children.forEach((child, idx) => {
        child.groupId = folder.groupId;
        child.parentId = undefined;
        child.x = (nextX + (idx % 3) * 2) % GROUP_COLUMNS;
        child.y = nextY + Math.floor((idx * 2) / GROUP_COLUMNS) * 2;
        child.size = 'medium';
        tiles.value.push(child);
      });
      tiles.value = tiles.value.filter((t) => t.id !== folderId);
      if (activeFolder.value?.id === folderId) {
        closeFolder();
      }
    }

    tombstones.value[folderId] = Date.now();
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
    const group = groups.value.find((g) => g.id === groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const occupied = tiles.value
      .filter((t) => t.groupId === groupId)
      .map((t) => {
        const s = getTileSpan(t.size, t.customSpan);
        return { x: t.x, y: t.y, w: s.w, h: s.h };
      });

    const fits = (col: number, row: number) =>
      col >= 0 &&
      col + span.w <= maxCols &&
      occupied.every(
        (o) =>
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
   * 将文件或子文件夹从所属文件夹移回到磁贴板
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

    const fileIndex = folder.children.findIndex((f) => f.id === fileId);
    if (fileIndex < 0) return;

    const [item] = folder.children.splice(fileIndex, 1);
    if (!item) return;
    item.groupId = targetGroupId || folder.groupId;
    item.parentId = undefined;
    item.size = 'medium';
    item.customSpan = undefined;
    item.updatedAt = new Date().toISOString().slice(0, 10);
    item.updatedAtMs = Date.now();

    const group = groups.value.find((g) => g.id === item.groupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const span = getTileSpan(item.size, item.customSpan);

    if (targetX === undefined || targetY === undefined) {
      const slot = findNearestFreeSlot(item.groupId, span, folder.y);
      item.x = slot.x;
      item.y = slot.y;
    } else {
      item.x = Math.max(0, Math.min(targetX, maxCols - span.w));
      item.y = Math.max(0, targetY);
    }

    tiles.value.push(item);
    saveState();
  }

  /**
   * 将任意磁贴（文件或文件夹）移入目标文件夹（含防环校验，支持无限层级嵌套）
   */
  function addFileToFolder(folderId: string, tileId: string) {
    if (folderId === tileId) return;
    const folder = getTileById(folderId);
    const item = getTileById(tileId);
    if (!folder || folder.type !== 'folder' || !item) return;
    if (item.systemApp || item.undeletable) return;

    // 防止将父文件夹拖入自己的子孙文件夹中形成循环引用
    if (item.type === 'folder' && isDescendantOfFolder(item, folderId)) {
      return;
    }

    const oldParent = findParentFolderOfTile(tileId);
    if (oldParent) {
      oldParent.children = oldParent.children.filter((c) => c.id !== tileId);
    } else {
      tiles.value = tiles.value.filter((t) => t.id !== tileId);
    }

    item.groupId = folder.groupId;
    item.parentId = folder.id;
    item.updatedAtMs = Date.now();
    folder.children.push(item);
    folder.updatedAt = new Date().toISOString().slice(0, 10);
    folder.updatedAtMs = Date.now();
    saveState();
  }

  /** 文件夹内的项直接移入另一个文件夹 */
  function moveFileBetweenFolders(fromFolderId: string, fileId: string, toFolderId: string) {
    if (fromFolderId === toFolderId) return;
    addFileToFolder(toFolderId, fileId);
  }

  /**
   * 在某个文件夹内部新建子文件夹（支持无限层级嵌套）
   */
  function addSubFolder(parentFolderId: string, title = '新建子文件夹'): FolderTileData | null {
    const parent = getTileById(parentFolderId);
    if (!parent || parent.type !== 'folder') return null;

    const nowStr = new Date().toISOString().slice(0, 10);
    const subFolder: FolderTileData = {
      id: `folder-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type: 'folder',
      title: title.trim() || '新建子文件夹',
      size: 'small',
      groupId: parent.groupId,
      parentId: parent.id,
      x: 0,
      y: 0,
      children: [],
      updatedAtMs: Date.now(),
      createdAt: nowStr,
      updatedAt: nowStr,
    };

    parent.children.push(subFolder);
    parent.updatedAt = nowStr;
    parent.updatedAtMs = Date.now();
    saveState();
    return subFolder;
  }

  function createFolderFromFiles(file1Id: string, file2Id: string) {
    const file1 = getTileById(file1Id);
    const file2 = getTileById(file2Id);
    if (!file1 || !file2) return;
    if (file1.systemApp || file1.undeletable || file2.systemApp || file2.undeletable) return;

    const newFolderId = `folder-${Date.now()}`;
    file1.parentId = newFolderId;
    file2.parentId = newFolderId;

    const newFolder: FolderTileData = {
      id: newFolderId,
      type: 'folder',
      title: '新建文件夹',
      size: 'medium',
      groupId: file2.groupId,
      x: file2.x,
      y: file2.y,
      children: [file2, file1],
      updatedAtMs: Date.now(),
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    tiles.value = tiles.value.filter((t) => t.id !== file1Id && t.id !== file2Id);
    tiles.value.push(newFolder);
    saveState();
  }

  function moveTile(tileId: string, targetGroupId: string, targetX: number, targetY: number) {
    const tile = getTileById(tileId);
    if (!tile) return;

    // 若原本在某个文件夹内，先从父文件夹移除
    const parent = findParentFolderOfTile(tileId);
    if (parent) {
      parent.children = parent.children.filter((c) => c.id !== tileId);
      tile.parentId = undefined;
      tiles.value.push(tile);
    }

    const group = groups.value.find((g) => g.id === targetGroupId);
    const maxCols = group?.widthColumns || GROUP_COLUMNS;
    const span = getTileSpan(tile.size, tile.customSpan);
    const clampedX = Math.max(0, Math.min(targetX, maxCols - span.w));
    const clampedY = Math.max(0, targetY);

    tile.groupId = targetGroupId;
    tile.x = clampedX;
    tile.y = clampedY;
    tile.updatedAt = new Date().toISOString().slice(0, 10);
    tile.updatedAtMs = Date.now();
    saveState();
  }

  function addNewFile(data: Partial<FileTileData>, targetGroupId?: string, targetFolderId?: string) {
    const id = data.id || `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const gid = targetGroupId || groups.value[0]?.id || 'group-common';
    const size = data.size || 'medium';
    const slot = findNearestFreeSlot(gid, getTileSpan(size, data.customSpan), 0);
    const today = new Date().toISOString().slice(0, 10);

    const newFile: FileTileData = {
      ...data,
      id,
      type: 'file',
      title: data.title?.trim() || '未命名文件',
      size,
      groupId: gid,
      x: slot.x,
      y: slot.y,
      fileType: data.fileType || 'doc',
      extension: data.extension || 'txt',
      description: data.description || '',
      content: data.content || '',
      tags: data.tags || [],
      sourceResultId: data.sourceResultId,
      updatedAtMs: Date.now(),
      createdAt: data.createdAt || today,
      updatedAt: today,
    };

    if (newFile.fileType !== 'exec' && !newFile.systemApp) attachCanonicalResource(newFile, resources.value);

    if (targetFolderId) {
      const folder = getTileById(targetFolderId);
      if (folder && folder.type === 'folder') {
        newFile.groupId = folder.groupId;
        newFile.parentId = folder.id;
        newFile.size = 'small';
        folder.children.push(newFile);
        folder.updatedAt = today;
        folder.updatedAtMs = Date.now();
        saveState();
        return newFile;
      }
    }

    tiles.value.push(newFile);
    saveState();
    return newFile;
  }

  function addNewFolder(title: string, targetGroupId?: string) {
    const id = `folder-${Date.now()}`;
    const gid = targetGroupId || groups.value[0]?.id || 'group-common';
    const slot = findNearestFreeSlot(gid, { w: 2, h: 2 }, 0);
    const newFolder: FolderTileData = {
      id,
      type: 'folder',
      title: title.trim() || '新文件夹',
      size: 'medium',
      groupId: gid,
      x: slot.x,
      y: slot.y,
      children: [],
      updatedAtMs: Date.now(),
      createdAt: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString().slice(0, 10),
    };

    tiles.value.push(newFolder);
    saveState();
    return newFolder;
  }

  /**
   * 记录已归入磁贴拓扑的搜索结果 ID → 所在位置文案映射（支持递归扫描所有嵌套文件夹）
   */
  const archivedSourceMap = computed(() => {
    const map = new Map<string, string>();
    const groupTitleMap = new Map<string, string>();
    for (const g of groups.value) {
      groupTitleMap.set(g.id, g.title);
    }

    const scanList = (list: TileData[], pathPrefix: string) => {
      for (const t of list) {
        if (t.type === 'file' && t.sourceResultId) {
          map.set(t.sourceResultId, pathPrefix);
        } else if (t.type === 'folder') {
          scanList(t.children, `${pathPrefix} / ${t.title}`);
        }
      }
    };

    for (const t of tiles.value) {
      const gTitle = groupTitleMap.get(t.groupId) || '磁贴分组';
      if (t.type === 'file' && t.sourceResultId) {
        map.set(t.sourceResultId, gTitle);
      } else if (t.type === 'folder') {
        scanList(t.children, `${gTitle} / ${t.title}`);
      }
    }
    return map;
  });

  /**
   * 将从聚合搜索拖拽过来的 1~N 条搜索结果导入磁贴目录拓扑（分组或任意深度文件夹）
   * 同时 0 请求直接复用搜索卡片已解码的缩略图 DataURL
   */
  function importSearchResultsToTopology(
    items: AggregateSearchResultItem[],
    targetType: 'group' | 'folder',
    targetId: string,
  ): number {
    if (!items || items.length === 0) return 0;
    const today = new Date().toISOString().slice(0, 10);
    let importedCount = 0;

    const createTileFromSearchResult = (
      item: AggregateSearchResultItem,
      groupId: string,
      size: TileSize,
      x: number,
      y: number,
      parentId?: string,
    ): FileTileData => {
      const tileId = `tile-sr-${crypto.randomUUID()}`;
      return {
        id: tileId,
        type: 'file',
        title: item.title,
        size,
        groupId,
        parentId,
        x,
        y,
        fileType: item.fileType,
        extension: item.extension,
        fileSize: item.fileSize,
        sizeBytes: item.sizeBytes,
        videoDuration: item.durationSeconds,
        videoWidth: item.width,
        videoHeight: item.height,
        description: `${item.snippet}\n\n来源会话：${item.sessionTitle}`,
        tags: [item.categoryLabel, item.sessionTitle],
        sourceResultId: item.id,
        sessionId: item.sessionId,
        sessionTitle: item.sessionTitle,
        isSessionLink: item.category === 'session',
        accountId: item.originAccountId,
        peerKey: item.peerRef ? `${item.peerRef.type}-${item.peerRef.id}` : undefined,
        peerType: item.peerRef?.type,
        accessHash: item.peerRef?.accessHash,
        noforwards: item.noforwards,
        groupedId: item.groupedId,
        albumCount: item.albumMsgIds?.length,
        ttlPeriod: item.ttlPeriod,
        photoInfo: item.photoInfo,
        videoInfo: item.videoInfo,
        fileInfo: item.fileInfo,
        sessionCredentialState:
          item.credentialState ?? (item.category === 'session'
            ? item.sessionKind === 'joined'
              ? 'joined'
              : 'temp_ephemeral'
            : undefined),
        inviteHash: item.inviteHash,
        peekExpiresAt: item.peekExpiresAt,
        lastVerifiedAt: item.lastVerifiedAt,
        autoRenew: item.autoRenew,
        thumb: item.thumbnailUrl || item.peerRef
            ? {
                // Telegram 来源的磁贴统一置为 pending，交给导入后的自动补图链路升级高清；
                // 只有非 Telegram（无 peerRef）的演示数据才能直接视为 ready。
                status: item.peerRef ? 'pending' : item.thumbnailUrl ? 'ready' : 'pending',
                // 只保留 Tier-0 模糊占位图，绝不把高清 base64 写进 localStorage
                strippedDataUrl: item.peerRef
                  ? item.thumbTier0Url
                  : item.thumbnailUrl || undefined,
                retryCount: 0,
                sourceRef: item.peerRef
                  ? {
                      accountId: item.originAccountId || '',
                      peerId: item.peerRef.id,
                      peerType: item.peerRef.type,
                      accessHash: item.peerRef.accessHash,
                      msgId: item.msgId,
                    }
                  : undefined,
              }
            : undefined,
        sources:
          item.peerRef && item.msgId
            ? [
                {
                  kind: 'origin',
                  accountId: item.originAccountId || '',
                  peerKey: `${item.peerRef.type}-${item.peerRef.id}`,
                  peerId: item.peerRef.id,
                  peerType: item.peerRef.type,
                  accessHash: item.peerRef.accessHash,
                  msgId: item.msgId,
                  groupedId: item.groupedId,
                },
              ]
            : undefined,
        updatedAtMs: Date.now(),
        createdAt: item.updatedAt || today,
        updatedAt: today,
      };
    };

    const createdTiles: FileTileData[] = [];

    if (targetType === 'group') {
      const group = groups.value.find((g) => g.id === targetId);
      if (!group) return 0;

      for (const item of items) {
        const slot = findNearestFreeSlot(group.id, { w: 2, h: 2 }, 0);
        const newFile = createTileFromSearchResult(item, group.id, 'medium', slot.x, slot.y);
        attachCanonicalResource(newFile, resources.value);
        tiles.value.push(newFile);
        createdTiles.push(newFile);
        importedCount++;
      }
    } else if (targetType === 'folder') {
      const folder = getTileById(targetId);
      if (!folder || folder.type !== 'folder') return 0;

      for (const item of items) {
        const newChild = createTileFromSearchResult(
          item,
          folder.groupId,
          'small',
          0,
          0,
          folder.id,
        );
        attachCanonicalResource(newChild, resources.value);
        folder.children.push(newChild);
        createdTiles.push(newChild);
        importedCount++;
      }
      if (importedCount > 0) {
        folder.updatedAt = today;
        folder.updatedAtMs = Date.now();
      }
    }

    if (importedCount > 0) {
      saveState();
      debugLoggerDataSource.emitFrontendLog({
        domain: 'archive.import',
        level: 'INFO',
        action: 'import_search_results',
        tags: {
          count: importedCount,
          targetType,
          targetId,
          withTier0: createdTiles.filter((tile) => Boolean(tile.thumb?.strippedDataUrl)).length,
          withoutThumb: createdTiles.filter((tile) => !tile.thumb?.strippedDataUrl).length,
          telegramBacked: createdTiles.filter((tile) => Boolean(tile.thumb?.sourceRef)).length,
        },
        message: '搜索结果已归入磁贴拓扑，开始自动补全高清封面',
      });
      // 导入即触发一次后台高清封面升级（Tier-0 → Tier-1），不再等待用户手动右键刷新
      scheduleTileCoverRefresh(
        createdTiles.map((tile) => tile.id),
        'search_import',
      );
    }
    return importedCount;
  }

  /**
   * 递归收集 Explore 拓扑中所有的文件夹节点列表（供批量归档目标目录选择器使用）
   */
  const allFoldersFlat = computed(() => {
    const result: { id: string; title: string; groupId: string; pathLabel: string }[] = [];
    const groupTitleMap = new Map<string, string>();
    for (const g of groups.value) {
      groupTitleMap.set(g.id, g.title);
    }

    const walk = (list: TileData[], prefix: string) => {
      for (const item of list) {
        if (item.type === 'folder') {
          const pathLabel = `${prefix} / ${item.title}`;
          result.push({
            id: item.id,
            title: item.title,
            groupId: item.groupId,
            pathLabel,
          });
          walk(item.children, pathLabel);
        }
      }
    };

    for (const t of tiles.value) {
      if (t.type === 'folder') {
        const gTitle = groupTitleMap.get(t.groupId) || '默认分组';
        const pathLabel = `${gTitle} / ${t.title}`;
        result.push({
          id: t.id,
          title: t.title,
          groupId: t.groupId,
          pathLabel,
        });
        walk(t.children, pathLabel);
      }
    }
    return result;
  });

  /**
   * 切换或设置磁贴多选状态
   */
  function toggleSelectTile(tileId: string, additive = false) {
    if (!additive) {
      selectedTileIds.value = [tileId];
      return;
    }
    const idx = selectedTileIds.value.indexOf(tileId);
    if (idx >= 0) {
      selectedTileIds.value = selectedTileIds.value.filter((id) => id !== tileId);
    } else {
      selectedTileIds.value = [...selectedTileIds.value, tileId];
    }
  }

  function setSelectedTileIds(ids: string[]) {
    selectedTileIds.value = Array.from(new Set(ids));
  }

  function clearSelectedTiles() {
    selectedTileIds.value = [];
  }

  function selectAllTilesInGroup(groupId?: string) {
    const candidates = groupId
      ? tiles.value.filter((t) => t.groupId === groupId && !t.undeletable && !t.systemApp)
      : tiles.value.filter((t) => !t.undeletable && !t.systemApp);
    selectedTileIds.value = candidates.map((t) => t.id);
  }

  /**
   * 批量删除已选磁贴（或传入的指定 ID 列表）
   */
  function batchDeleteTiles(ids?: string[]): number {
    const targetIds = Array.from(new Set(ids ?? selectedTileIds.value));
    if (targetIds.length === 0) return 0;

    let deletedCount = 0;
    const now = Date.now();
    const recordTombstones = (item: TileData) => {
      tombstones.value[item.id] = now;
      void opfsExploreStorage.deleteThumbnail(item.id);
      if (item.type === 'folder') {
        item.children.forEach(recordTombstones);
      }
    };

    for (const tileId of targetIds) {
      const target = getTileById(tileId);
      if (!target || target.undeletable || target.systemApp) continue;
      recordTombstones(target);

      const parentFolder = findParentFolderOfTile(tileId);
      if (parentFolder) {
        parentFolder.children = parentFolder.children.filter((c) => c.id !== tileId);
        parentFolder.updatedAt = new Date().toISOString().slice(0, 10);
        parentFolder.updatedAtMs = now;
      } else {
        tiles.value = tiles.value.filter((t) => t.id !== tileId);
      }
      if (activeFolder.value?.id === tileId) {
        closeFolder();
      }
      deletedCount += 1;
    }

    selectedTileIds.value = selectedTileIds.value.filter((id) => !targetIds.includes(id));
    if (deletedCount > 0) {
      saveState();
      debugLoggerDataSource.emitFrontendLog({
        domain: 'archive.tile',
        level: 'INFO',
        action: 'batch_delete_tiles',
        tags: { count: deletedCount, tileIds: targetIds.join(',') },
      });
    }
    return deletedCount;
  }

  /**
   * 批量将已选磁贴（或传入的指定 ID 列表）移入目标文件夹
   */
  function batchMoveTilesToFolder(folderId: string, ids?: string[]): number {
    const folder = getTileById(folderId);
    if (!folder || folder.type !== 'folder') return 0;

    const targetIds = Array.from(new Set(ids ?? selectedTileIds.value));
    if (targetIds.length === 0) return 0;

    let movedCount = 0;
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    for (const tileId of targetIds) {
      if (tileId === folderId) continue;
      const item = getTileById(tileId);
      if (!item || item.systemApp || item.undeletable) continue;
      if (item.type === 'folder' && isDescendantOfFolder(item, folderId)) continue;

      const oldParent = findParentFolderOfTile(tileId);
      if (oldParent) {
        if (oldParent.id === folderId) continue;
        oldParent.children = oldParent.children.filter((c) => c.id !== tileId);
        oldParent.updatedAt = today;
        oldParent.updatedAtMs = now;
      } else {
        tiles.value = tiles.value.filter((t) => t.id !== tileId);
      }

      item.groupId = folder.groupId;
      item.parentId = folder.id;
      item.updatedAt = today;
      item.updatedAtMs = now;
      if (!folder.children.some((c) => c.id === item.id)) {
        folder.children.push(item);
      }
      movedCount += 1;
    }

    if (movedCount > 0) {
      folder.updatedAt = today;
      folder.updatedAtMs = now;
      selectedTileIds.value = [];
      saveState();
      debugLoggerDataSource.emitFrontendLog({
        domain: 'archive.tile',
        level: 'INFO',
        action: 'batch_move_to_folder',
        tags: { folderId, folderTitle: folder.title, count: movedCount },
      });
    }
    return movedCount;
  }

  /**
   * 批量将已选磁贴（或传入的指定 ID 列表）移入目标分组并自动排布网格空位
   */
  function batchMoveTilesToGroup(
    targetGroupId: string,
    anchorX?: number,
    anchorY?: number,
    ids?: string[],
  ): number {
    const group = groups.value.find((g) => g.id === targetGroupId);
    if (!group) return 0;

    const targetIds = Array.from(new Set(ids ?? selectedTileIds.value));
    if (targetIds.length === 0) return 0;

    const maxCols = group.widthColumns || GROUP_COLUMNS;
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    let movedCount = 0;

    targetIds.forEach((tileId, idx) => {
      const tile = getTileById(tileId);
      if (!tile) return;

      const parent = findParentFolderOfTile(tileId);
      if (parent) {
        parent.children = parent.children.filter((c) => c.id !== tileId);
        parent.updatedAt = today;
        parent.updatedAtMs = now;
        tile.parentId = undefined;
        tile.size = tile.size === 'small' ? 'medium' : tile.size;
        tiles.value.push(tile);
      }

      const span = getTileSpan(tile.size, tile.customSpan);
      tile.groupId = targetGroupId;
      if (idx === 0 && anchorX !== undefined && anchorY !== undefined) {
        tile.x = Math.max(0, Math.min(anchorX, maxCols - span.w));
        tile.y = Math.max(0, anchorY);
      } else {
        const slot = findNearestFreeSlot(targetGroupId, span, anchorY ?? 0);
        tile.x = slot.x;
        tile.y = slot.y;
      }
      tile.updatedAt = today;
      tile.updatedAtMs = now;
      movedCount += 1;
    });

    if (movedCount > 0) {
      selectedTileIds.value = [];
      saveState();
      debugLoggerDataSource.emitFrontendLog({
        domain: 'archive.tile',
        level: 'INFO',
        action: 'batch_move_to_group',
        tags: { groupId: targetGroupId, groupTitle: group.title, count: movedCount },
      });
    }
    return movedCount;
  }

  /**
   * 批量拖拽多个磁贴合并到某个普通文件磁贴上，自动创建文件夹并收入所有磁贴
   */
  function batchCreateFolderFromTiles(hostTileId: string, draggedIds: string[]): FolderTileData | null {
    const hostTile = getTileById(hostTileId);
    if (!hostTile || hostTile.type !== 'file' || hostTile.systemApp || hostTile.undeletable) {
      return null;
    }

    const allIds = Array.from(new Set([hostTileId, ...draggedIds]));
    const validItems: TileData[] = [];
    for (const id of allIds) {
      const item = getTileById(id);
      if (!item || item.systemApp || item.undeletable) continue;
      validItems.push(item);
    }
    if (validItems.length < 2) return null;

    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const newFolderId = `folder-${now}`;
    const hostGroupId = hostTile.groupId;
    const hostX = hostTile.x;
    const hostY = hostTile.y;

    for (const item of validItems) {
      const parent = findParentFolderOfTile(item.id);
      if (parent) {
        parent.children = parent.children.filter((c) => c.id !== item.id);
      } else {
        tiles.value = tiles.value.filter((t) => t.id !== item.id);
      }
      item.groupId = hostGroupId;
      item.parentId = newFolderId;
      item.updatedAt = today;
      item.updatedAtMs = now;
    }

    const newFolder: FolderTileData = {
      id: newFolderId,
      type: 'folder',
      title: '新建文件夹',
      size: 'medium',
      groupId: hostGroupId,
      x: hostX,
      y: hostY,
      children: validItems,
      updatedAtMs: now,
      createdAt: today,
      updatedAt: today,
    };

    tiles.value.push(newFolder);
    selectedTileIds.value = [];
    saveState();
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.tile',
      level: 'INFO',
      action: 'batch_create_folder',
      tags: { folderId: newFolderId, count: validItems.length },
    });
    return newFolder;
  }

  /**
   * 打开通用资源管理器 / Finder 目录选择器弹窗（用于批量移动磁贴或选择归档目标路径）
   */
  function openExplorerPickerForTiles(ids?: string[]) {
    const targetIds = Array.from(new Set(ids ?? selectedTileIds.value));
    const defaultFolder = allFoldersFlat.value[0];
    explorerPickerState.value = {
      isOpen: true,
      mode: 'move-tiles',
      tileIds: targetIds,
      selectedTargetType: defaultFolder ? 'folder' : 'group',
      selectedTargetId: defaultFolder ? defaultFolder.id : (groups.value[0]?.id || 'group-common'),
      creatingFolderInTargetId: null,
      newFolderDraft: '',
    };
  }

  function selectExplorerTarget(targetType: 'group' | 'folder', targetId: string) {
    explorerPickerState.value.selectedTargetType = targetType;
    explorerPickerState.value.selectedTargetId = targetId;
  }

  function closeExplorerPicker() {
    explorerPickerState.value.isOpen = false;
    explorerPickerState.value.creatingFolderInTargetId = null;
    explorerPickerState.value.newFolderDraft = '';
  }

  function confirmExplorerPickerMove(): number {
    const { tileIds, selectedTargetType, selectedTargetId } = explorerPickerState.value;
    let moved = 0;
    if (selectedTargetType === 'folder') {
      moved = batchMoveTilesToFolder(selectedTargetId, tileIds);
    } else {
      moved = batchMoveTilesToGroup(selectedTargetId, undefined, undefined, tileIds);
    }
    folderSelectedTileIds.value = [];
    closeExplorerPicker();
    return moved;
  }

  /**
   * 文件夹弹窗内部多选与框选操作
   */
  function toggleSelectFolderChildTile(tileId: string, additive = false) {
    if (!additive) {
      folderSelectedTileIds.value = [tileId];
      return;
    }
    if (folderSelectedTileIds.value.includes(tileId)) {
      folderSelectedTileIds.value = folderSelectedTileIds.value.filter((id) => id !== tileId);
    } else {
      folderSelectedTileIds.value = [...folderSelectedTileIds.value, tileId];
    }
  }

  function setFolderSelectedTileIds(ids: string[]) {
    folderSelectedTileIds.value = Array.from(new Set(ids));
  }

  function clearFolderSelectedTiles() {
    folderSelectedTileIds.value = [];
  }

  /**
   * 当聚合搜索卡片加载了高清缩略图后，同步回写已归入拓扑的对应磁贴。
   * 关键：高清字节写入 OPFS 并生成 ObjectURL，只把 Tier-0 模糊图留在 localStorage。
   */
  function applyUpdatedSearchResultThumb(sourceResultId: string, hdDataUrl: string) {
    if (!sourceResultId || !hdDataUrl) return;
    const targets: FileTileData[] = [];
    const walk = (list: TileData[]) => {
      for (const item of list) {
        if (item.type === 'file' && item.sourceResultId === sourceResultId) {
          targets.push(item);
        } else if (item.type === 'folder') {
          walk(item.children);
        }
      }
    };
    walk(tiles.value);
    if (targets.length === 0) return;

    const bytes = dataUrlToBytes(hdDataUrl);
    if (!bytes) {
      logCover(
        'tile_thumb_persist_skipped',
        'WARN',
        { sourceResultId, reason: 'BAD_DATA_URL', length: hdDataUrl.length },
        '高清缩略图 Data URL 无法解码，回退为内存 ObjectURL',
      );
      for (const item of targets) {
        item.thumb = {
          ...(item.thumb ?? { retryCount: 0 }),
          status: 'ready',
          objectUrl: hdDataUrl,
        };
      }
      saveState();
      return;
    }

    for (const item of targets) {
      void saveTileThumbnail(item.id, bytes, item.thumb?.strippedDataUrl)
        .then(() => {
          logCover(
            'tile_thumb_persisted',
            'INFO',
            { tileId: item.id, sourceResultId, bytes: bytes.byteLength },
            '搜索结果高清缩略图已写入 OPFS',
          );
        })
        .catch((error: unknown) => {
          const info = classifyTelegramError(error);
          logCover(
            'tile_thumb_persist_error',
            'WARN',
            { tileId: item.id, sourceResultId, bucket: info.bucket, code: info.code },
            info.description,
          );
        });
    }
  }

  function dataUrlToBytes(dataUrl: string): Uint8Array | null {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return null;
    try {
      const binary = atob(dataUrl.slice(comma + 1));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch {
      return null;
    }
  }

  function isSessionFileTile(file: FileTileData): boolean {
    return Boolean(
      file.isSessionLink ||
        file.sessionCredentialState ||
        file.extension?.toLowerCase() === 'tg',
    );
  }

  /**
   * 针对单个文件/会话磁贴从 Telegram 重新拉取封面（会话磁贴拉取会话头像，非会话磁贴拉取视频/图片/文档自身缩略图）
   */
  async function fetchAndApplyCoverForFileTile(tile: FileTileData): Promise<boolean> {
    const startedAt = Date.now();
    const chatStore = useChatStore();
    const src = tile.sources?.[0];
    const srcRef = tile.thumb?.sourceRef;
    const accountId = tile.accountId || src?.accountId || srcRef?.accountId || chatStore.accountId;
    const baseTags = {
      tileId: tile.id,
      msgId: src?.msgId ?? srcRef?.msgId ?? 0,
      sessionTile: isSessionFileTile(tile),
      hasTier0: Boolean(tile.thumb?.strippedDataUrl),
    };
    if (!accountId) {
      logCover('tile_cover_skipped', 'WARN', { ...baseTags, bucket: 'NO_ACCOUNT' }, '磁贴缺少账号，无法拉取封面');
      return false;
    }
    if (!chatStore.isOnline) {
      logCover('tile_cover_skipped', 'WARN', { ...baseTags, bucket: 'OFFLINE', accountId }, '账号不在线，跳过磁贴封面拉取');
      return false;
    }

    const peerKey = (tile.peerKey || src?.peerKey || tile.sessionId || (srcRef ? `${srcRef.peerType || 'channel'}-${srcRef.peerId}` : '')) as TgPeerKey;
    const parsePeerFromKey = (k: string): TgPeerRef | undefined => {
      const m = /^(user|chat|channel)-(\d+)$/.exec(k);
      return m ? { type: m[1] as TgPeerRef['type'], id: m[2]! } : undefined;
    };

    let dialog = peerKey ? chatStore.dialogs[peerKey] : undefined;
    const peerType = tile.peerType || src?.peerType || srcRef?.peerType || dialog?.peer.type || parsePeerFromKey(peerKey)?.type || 'channel';
    const peerId = src?.peerId || srcRef?.peerId || dialog?.peer.id || parsePeerFromKey(peerKey)?.id || peerKey.replace(/^(user|chat|channel)-/, '');
    const accessHash = tile.accessHash || src?.accessHash || srcRef?.accessHash || dialog?.peer.accessHash;

    // 1. 会话磁贴：拉取会话头像
    if (isSessionFileTile(tile)) {
      if (!dialog?.avatar && tile.username) {
        try {
          const resolved = await telegramBusClient.chatCommand.resolveUsername(accountId, tile.username);
          if (resolved) {
            dialog = resolved;
          }
        } catch (error) {
          const info = classifyTelegramError(error);
          logCover('tile_cover_resolve_error', 'WARN', { ...baseTags, branch: 'username', bucket: info.bucket, code: info.code }, info.description);
        }
      }
      if (!dialog?.avatar && tile.inviteHash) {
        try {
          const preview = await telegramBusClient.chatCommand.checkChatInvite(accountId, tile.inviteHash);
          if (preview.dialog) {
            dialog = preview.dialog;
          }
        } catch (error) {
          const info = classifyTelegramError(error);
          logCover('tile_cover_resolve_error', 'WARN', { ...baseTags, branch: 'invite', bucket: info.bucket, code: info.code }, info.description);
        }
      }
      if (!dialog && !chatStore.archiveLoaded) {
        try {
          await chatStore.refreshArchiveDialogs();
          dialog = peerKey ? chatStore.dialogs[peerKey] : undefined;
        } catch (error) {
          const info = classifyTelegramError(error);
          logCover('tile_cover_resolve_error', 'WARN', { ...baseTags, branch: 'archive', bucket: info.bucket, code: info.code }, info.description);
        }
      }

      if (dialog?.avatar) {
        try {
          const avatarMedia = await telegramBusClient.cover.getAvatar(
            accountId,
            dialog.peer,
            dialog.avatar.photoId,
            dialog.avatar.dcId,
          );
          if (avatarMedia?.bytes && avatarMedia.bytes.byteLength > 0) {
            await saveTileThumbnail(tile.id, new Uint8Array(avatarMedia.bytes), tile.thumb?.strippedDataUrl);
            logCover(
              'tile_cover_ok',
              'INFO',
              { ...baseTags, branch: 'avatar', bytes: avatarMedia.bytes.byteLength, mime: avatarMedia.mimeType },
              '会话磁贴头像已升级为高清',
              Date.now() - startedAt,
            );
            return true;
          }
          logCover('tile_cover_skipped', 'WARN', { ...baseTags, branch: 'avatar', bucket: 'EMPTY_BYTES' }, '会话头像返回空字节');
        } catch (error) {
          const info = classifyTelegramError(error);
          logCover(
            'tile_cover_error',
            'ERROR',
            { ...baseTags, branch: 'avatar', bucket: info.bucket, code: info.code, retryable: info.retryable },
            info.description,
            Date.now() - startedAt,
          );
          if (dialog.avatar.thumb) {
            tile.thumb = {
              ...(tile.thumb ?? { retryCount: 0 }),
              status: 'ready',
              strippedDataUrl: dialog.avatar.thumb,
            };
            return true;
          }
        }
      } else {
        logCover('tile_cover_skipped', 'WARN', { ...baseTags, branch: 'avatar', bucket: 'NO_THUMB_SOURCE' }, '会话没有可用头像');
      }
      return false;
    }

    // 2. 非会话媒体磁贴（视频 / 图片 / 文件）：必须拉取该消息自身的缩略图，绝不使用会话头像
    if (!peerId) {
      logCover('tile_cover_skipped', 'WARN', { ...baseTags, bucket: 'NO_PEER', peerKey }, '磁贴缺少 peer 定位信息');
      return false;
    }
    const peer: TgPeerRef = { type: peerType, id: peerId, accessHash };
    const msgId = src?.msgId ?? srcRef?.msgId ?? 0;

    let photoInfo = tile.photoInfo;
    let videoInfo = tile.videoInfo;
    let fileInfo = tile.fileInfo;

    // 优先通过 getHistoryAround 刷新最新消息媒体定位信息（同时可修复过期的 fileReference）
    if (msgId > 0) {
      try {
        const page = await telegramBusClient.chatRead.getHistoryAround(accountId, peer, msgId, 3);
        const found = page.messages.find((m) => m.id === msgId) ?? page.messages[0];
        if (found?.media) {
          photoInfo = found.media.photo ?? photoInfo;
          videoInfo = found.media.video ?? videoInfo;
          fileInfo = found.media.file ?? fileInfo;
          tile.photoInfo = photoInfo;
          tile.videoInfo = videoInfo;
          tile.fileInfo = fileInfo;
          const resource = resources.value[tile.resourceId ?? ''];
          if (resource) {
            resource.photoInfo = photoInfo;
            resource.videoInfo = videoInfo;
            resource.fileInfo = fileInfo;
            resource.updatedAtMs = Date.now();
          }
        }
        logCover(
          'tile_cover_history_refresh',
          photoInfo || videoInfo || fileInfo ? 'DEBUG' : 'WARN',
          {
            ...baseTags,
            returned: page.messages.length,
            gotPhoto: Boolean(photoInfo),
            gotVideo: Boolean(videoInfo),
            gotFile: Boolean(fileInfo),
          },
          '磁贴封面拉取前刷新了消息定位信息',
        );
      } catch (error) {
        const info = classifyTelegramError(error);
        logCover(
          'tile_cover_history_refresh_error',
          'WARN',
          { ...baseTags, branch: 'history', bucket: info.bucket, code: info.code, retryable: info.retryable },
          info.description,
        );
      }
    }

    let branch = 'none';
    let sizeType = '';
    try {
      let mediaFile: TgMediaFile | null = null;
      if (photoInfo) {
        const size = coverSizeOf(photoInfo);
        branch = 'photo';
        sizeType = size.type;
        mediaFile = await telegramBusClient.cover.getPhoto(accountId, peer, msgId, photoInfo, size);
      } else if (videoInfo) {
        const vSource = videoPreviewOf(videoInfo);
        if (vSource?.kind === 'photo') {
          const size = coverSizeOf(vSource.photo);
          branch = 'video_cover';
          sizeType = size.type;
          mediaFile = await telegramBusClient.cover.getPhoto(accountId, peer, msgId, vSource.photo, size);
        } else if (vSource?.kind === 'document') {
          branch = 'video_doc_thumb';
          sizeType = vSource.size.type;
          mediaFile = await telegramBusClient.cover.getDocumentThumb(accountId, peer, msgId, videoInfo, vSource.size);
        } else {
          logCover('tile_cover_skipped', 'WARN', { ...baseTags, branch: 'video', bucket: 'NO_THUMB_SOURCE' }, '视频没有可用缩略图档位');
        }
      } else if (fileInfo?.preview) {
        branch = 'file_doc_thumb';
        sizeType = fileInfo.preview.type;
        mediaFile = await telegramBusClient.cover.getDocumentThumb(accountId, peer, msgId, fileInfo, fileInfo.preview);
      } else {
        logCover('tile_cover_skipped', 'WARN', { ...baseTags, branch: 'file', bucket: 'NO_MEDIA' }, '磁贴没有可下载媒体或缩略图档位');
      }

      if (mediaFile?.bytes && mediaFile.bytes.byteLength > 0) {
        // 只把高清字节写入 OPFS，保留原 Tier-0 模糊图作为 localStorage 占位
        await saveTileThumbnail(tile.id, new Uint8Array(mediaFile.bytes), tile.thumb?.strippedDataUrl);
        logCover(
          'tile_cover_ok',
          'INFO',
          {
            ...baseTags,
            branch,
            sizeType,
            bytes: mediaFile.bytes.byteLength,
            mime: mediaFile.mimeType,
          },
          '磁贴封面已升级为高清',
          Date.now() - startedAt,
        );
        return true;
      }

      const fallbackStripped =
        photoInfo?.thumb || videoInfo?.cover?.thumb || videoInfo?.thumb || fileInfo?.thumb;
      if (fallbackStripped) {
        tile.thumb = {
          ...(tile.thumb ?? { retryCount: 0 }),
          status: 'ready',
          strippedDataUrl: fallbackStripped,
        };
        logCover('tile_cover_fallback', 'WARN', { ...baseTags, branch, bucket: 'EMPTY_BYTES' }, '高清缩略图不可用，回退到 Tier-0 模糊图');
        return true;
      }
    } catch (error) {
      const info = classifyTelegramError(error);
      logCover(
        'tile_cover_error',
        'ERROR',
        {
          ...baseTags,
          branch,
          sizeType,
          bucket: info.bucket,
          code: info.code,
          retryable: info.retryable,
        },
        info.description,
        Date.now() - startedAt,
      );
      if (tile.thumb) {
        tile.thumb.status = 'failed';
        tile.thumb.retryCount = (tile.thumb.retryCount || 0) + 1;
      }
    }
    return false;
  }

  /**
   * 为指定磁贴排队后台封面升级任务（导入搜索结果 / 会话归入磁贴后立即调用）。
   * 走 coverImageBus 的 archive_tiles 通道，避免批量导入时打爆 Telegram。
   */
  function scheduleTileCoverRefresh(rawTileIds: string[], reason: string): void {
    const ids = Array.from(new Set(rawTileIds));
    const targets: FileTileData[] = [];
    const seenResources = new Set<string>();
    for (const id of ids) {
      const tile = getTileById(id);
      if (!tile || tile.type !== 'file') continue;
      const resourceKey = tile.resourceId ?? tile.id;
      if (seenResources.has(resourceKey)) continue;
      if (
        !tile.peerKey &&
        !tile.sessionId &&
        !tile.sources?.length &&
        !tile.thumb?.sourceRef &&
        !isSessionFileTile(tile)
      ) {
        continue;
      }
      // 纯文本搜索结果没有可下载媒体，直接跳过，避免无意义的 getHistoryAround
      if (!isSessionFileTile(tile) && !tile.photoInfo && !tile.videoInfo && !tile.fileInfo) {
        continue;
      }
      targets.push(tile);
      seenResources.add(resourceKey);
    }
    if (targets.length === 0) return;

    logCover(
      'tile_cover_scheduled',
      'INFO',
      {
        reason,
        count: targets.length,
        tileIds: targets.slice(0, 8).map((tile) => tile.id).join(','),
      },
      '磁贴封面后台升级任务已入队',
    );

    for (const tile of targets) {
      void coverImageBus
        .request<boolean>({
          key: `tile-cover-${tile.id}`,
          lane: 'archive_tiles',
          priority: 22,
          fetch: () => fetchAndApplyCoverForFileTile(tile),
        })
        .then((ok) => {
          if (ok) saveState();
        })
        .catch((error: unknown) => {
          const info = classifyTelegramError(error);
          logCover(
            'tile_cover_queue_error',
            'ERROR',
            { tileId: tile.id, reason, bucket: info.bucket, code: info.code },
            info.description,
          );
        });
    }
  }

  function showCoverRefreshBanner(text: string) {
    coverRefreshBannerText.value = text;
    window.setTimeout(() => {
      if (coverRefreshBannerText.value === text) {
        coverRefreshBannerText.value = null;
      }
    }, 3200);
  }

  /** 磁贴封面链路的统一结构化日志（domain: archive.cover）。 */
  function logCover(
    action: string,
    level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
    tags: Record<string, string | number | boolean | undefined>,
    message?: string,
    durMs?: number,
  ) {
    debugLoggerDataSource.emitFrontendLog({
      domain: 'archive.cover',
      action,
      level,
      message,
      durMs,
      tags,
    });
  }

  function findSessionTileIds(peerKeys: string[]): string[] {
    const keys = new Set(peerKeys);
    const ids: string[] = [];
    const walk = (list: TileData[]) => {
      for (const item of list) {
        if (item.type === 'folder') walk(item.children);
        else if ((item.isSessionLink || item.sessionCredentialState) && keys.has(item.peerKey || item.sessionId || '')) ids.push(item.id);
      }
    };
    walk(tiles.value);
    return ids;
  }

  /**
   * 批量刷新指定磁贴（或文件夹内全部子磁贴）的封面缩略图
   */
  async function refreshTileCoversByIds(ids?: string[]): Promise<number> {
    const rawIds = Array.from(
      new Set(
        ids && ids.length > 0
          ? ids
          : folderSelectedTileIds.value.length > 0
            ? folderSelectedTileIds.value
            : selectedTileIds.value,
      ),
    );
    if (rawIds.length === 0 || isRefreshingTileCovers.value) return 0;

    const targetFiles: FileTileData[] = [];
    const seenResources = new Set<string>();
    const collectFiles = (item: TileData) => {
      if (item.systemApp || item.undeletable) return;
      if (item.type === 'file') {
        const resourceKey = item.resourceId ?? item.id;
        if (!seenResources.has(resourceKey)) {
          seenResources.add(resourceKey);
          targetFiles.push(item);
        }
      } else if (item.type === 'folder') {
        item.children.forEach(collectFiles);
      }
    };

    for (const id of rawIds) {
      const t = getTileById(id);
      if (t) collectFiles(t);
    }
    if (targetFiles.length === 0) return 0;

    isRefreshingTileCovers.value = true;
    showCoverRefreshBanner(`正在并行刷新 ${targetFiles.length} 个磁贴封面…`);
    let refreshedCount = 0;

    try {
      // 接入全局封面加载总线，并发 8 执行批量刷新
      const tasks = targetFiles.map((fileTile) =>
        coverImageBus
          .request<boolean>({
            key: `tile-cover-${fileTile.id}`,
            lane: 'archive_tiles',
            priority: 25,
            fetch: () => fetchAndApplyCoverForFileTile(fileTile),
          })
          .then((ok) => {
            if (ok) refreshedCount += 1;
            return ok;
          })
          .catch(() => false),
      );

      await Promise.all(tasks);
      if (refreshedCount > 0) {
        saveState();
      }
      showCoverRefreshBanner(
        refreshedCount > 0
          ? `已成功刷新 ${refreshedCount} 个磁贴封面`
          : '未能获取到新的缩略图（请检查 Telegram 在线状态）',
      );
    } finally {
      isRefreshingTileCovers.value = false;
    }
    return refreshedCount;
  }

  /**
   * 重新载入当前文件夹（或全局磁贴板）中缺失或加载失败的贴图/封面
   */
  async function reloadMissingOrFailedTileCovers(scopeFolderId?: string | null): Promise<number> {
    if (isRefreshingTileCovers.value) return 0;
    const chatStore = useChatStore();

    let scopeList: TileData[] = tiles.value;
    if (scopeFolderId) {
      const folder = getTileById(scopeFolderId);
      if (folder && folder.type === 'folder') {
        scopeList = folder.children;
      }
    }

    const candidates: FileTileData[] = [];
    const scanMissing = (list: TileData[]) => {
      for (const item of list) {
        if (item.systemApp || item.undeletable) continue;
        if (item.type === 'file') {
          const isSess = isSessionFileTile(item);
          const key = (item.peerKey || item.sessionId || '') as TgPeerKey;
          const hasDialogAvatar = isSess && key && Boolean(chatStore.dialogs[key]?.avatar?.thumb);
          const hasOwnThumb = Boolean(
            (item.thumb?.objectUrl || item.thumb?.strippedDataUrl) &&
              item.thumb?.status !== 'failed' &&
              !item.thumb?.strippedDataUrl?.includes('images.unsplash.com'),
          );
          if (!hasOwnThumb && !hasDialogAvatar) {
            candidates.push(item);
          }
        } else if (item.type === 'folder') {
          scanMissing(item.children);
        }
      }
    };

    scanMissing(scopeList);
    // 若全部磁贴都已有占位缩略图，则对该作用域内的所有 Telegram 磁贴执行一次高清封面重载
    if (candidates.length === 0) {
      const collectAllScopeFiles = (list: TileData[]) => {
        for (const item of list) {
          if (item.systemApp || item.undeletable) continue;
          if (item.type === 'file' && (item.peerKey || item.sessionId || item.sources?.length || item.thumb?.sourceRef)) {
            candidates.push(item);
          } else if (item.type === 'folder') {
            collectAllScopeFiles(item.children);
          }
        }
      };
      collectAllScopeFiles(scopeList);
    }

    if (candidates.length === 0) {
      showCoverRefreshBanner('当前区域没有需要重新加载贴图的磁贴');
      return 0;
    }

    isRefreshingTileCovers.value = true;
    showCoverRefreshBanner(`正在并行重新载入 ${candidates.length} 个磁贴的贴图…`);
    let recovered = 0;

    try {
      // 接入全局封面加载总线，并发 8 执行贴图重载
      const tasks = candidates.map((tile) =>
        coverImageBus
          .request<boolean>({
            key: `tile-cover-${tile.id}`,
            lane: 'archive_tiles',
            priority: 20,
            fetch: () => fetchAndApplyCoverForFileTile(tile),
          })
          .then((ok) => {
            if (ok) recovered += 1;
            return ok;
          })
          .catch(() => false),
      );

      await Promise.all(tasks);
      if (recovered > 0) {
        saveState();
      }
      showCoverRefreshBanner(
        recovered > 0
          ? `已成功重新载入 ${recovered} 个磁贴贴图`
          : '贴图重载完成（部分内容无缩略图或需连接 Telegram）',
      );
    } finally {
      isRefreshingTileCovers.value = false;
    }
    return recovered;
  }

  loadState();

  return {
    groups,
    tiles,
    tombstones,
    resources,
    tempCredentials,
    vaultConfig,
    revision,
    updatedAtMs,
    isDirty,
    wallpaper,
    acrylicOpacity,
    acrylicBlur,
    searchQuery,
    selectedFile,
    activeFolder,
    folderPathStack,
    editingGroupId,
    editingGroupTitleDraft,
    resizingGroupWidthId,
    resizingGroupLiveCols,
    resizingTileId,
    resizingTileSpan,
    isEditingFolderModalTitle,
    folderModalTitleDraft,
    isEditingFileDetail,
    fileDetailTitleDraft,
    fileDetailDescDraft,
    selectedTileIds,
    marqueeState,
    folderSelectedTileIds,
    folderMarqueeState,
    isRefreshingTileCovers,
    coverRefreshBannerText,
    explorerPickerState,
    contextMenu,
    dragState,
    groupDragState,
    pendingFolderChildDrag,
    beginFolderChildDrag,
    filteredTiles,
    tilesByGroup,
    columns,
    allFoldersFlat,
    loadState,
    saveState,
    resetToDefault,
    buildExploreManifest,
    applyExploreManifest,
    exportColdArchive,
    importColdArchive,
    saveTileThumbnail,
    retryFailedThumbnails,
    getTileById,
    findParentFolderOfTile,
    isDescendantOfFolder,
    openFile,
    openTelegramMedia,
    closeFile,
    openFolder,
    navigateToBreadcrumbFolder,
    closeFolder,
    openContextMenu,
    closeContextMenu,
    resizeTile,
    resizeTileSpan,
    renameTile,
    deleteTile,
    renameChildFile,
    deleteChildFile,
    upgradeSessionTileCredential,
    togglePinOfflineAsset,
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
    addSubFolder,
    createFolderFromFiles,
    moveTile,
    toggleSelectTile,
    setSelectedTileIds,
    clearSelectedTiles,
    selectAllTilesInGroup,
    batchDeleteTiles,
    batchMoveTilesToFolder,
    batchMoveTilesToGroup,
    batchCreateFolderFromTiles,
    openExplorerPickerForTiles,
    selectExplorerTarget,
    closeExplorerPicker,
    confirmExplorerPickerMove,
    toggleSelectFolderChildTile,
    setFolderSelectedTileIds,
    clearFolderSelectedTiles,
    applyUpdatedSearchResultThumb,
    refreshTileCoversByIds,
    findSessionTileIds,
    reloadMissingOrFailedTileCovers,
    scheduleTileCoverRefresh,
    addNewFile,
    addNewFolder,
    archivedSourceMap,
    importSearchResultsToTopology,
    applyDisplacedPositions: (groupId: string, positions: Record<string, { x: number; y: number }>) => {
      const list = tiles.value.filter((t) => t.groupId === groupId);
      for (const t of list) {
        const pos = positions[t.id];
        if (pos) {
          t.x = pos.x;
          t.y = pos.y;
        }
      }
      saveState();
    },
  };
});

