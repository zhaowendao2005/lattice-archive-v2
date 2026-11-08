import type { FileTileData, TileData } from '../types/tile';
import type { ExploreResource } from '@/stores/archive/types';
import { getFileVisual } from '../components/tiles/fileVisuals';

export function isTelegramMediaTile(tile: TileData, resources: Record<string, ExploreResource>): boolean {
  if (tile.type !== 'file' || (tile.fileType !== 'image' && tile.fileType !== 'video')) return false;
  const resource = tile.resourceId ? resources[tile.resourceId] : undefined;
  return resource?.kind === 'telegram-message' || Boolean(tile.sources?.length && (tile.videoInfo || tile.photoInfo));
}

export function tileTypeLabel(tile: TileData, resources: Record<string, ExploreResource>): string {
  if (tile.type !== 'file') return '文件夹';
  if (tile.isSessionLink || tile.sessionCredentialState) return 'Telegram 会话';
  if (isTelegramMediaTile(tile, resources)) return 'Telegram 媒体链接';
  return tile.fileType.toUpperCase();
}

const MIME_SUBTYPE_MAP: Record<string, string> = {
  quicktime: 'MOV',
  'x-matroska': 'MKV',
  'x-msvideo': 'AVI',
  jpeg: 'JPG',
  'svg+xml': 'SVG',
  mpeg: 'MP3',
  'x-wav': 'WAV',
  'x-flac': 'FLAC',
  'x-rar-compressed': 'RAR',
  'x-7z-compressed': '7Z',
  'x-tar': 'TAR',
  gzip: 'GZ',
  plain: 'TXT',
  markdown: 'MD',
};

function extractExtFromFileName(fileName?: string): string | null {
  if (!fileName) return null;
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(fileName.trim());
  return m?.[1] ? m[1].toUpperCase() : null;
}

function extractExtFromMime(mimeType?: string): string | null {
  if (!mimeType) return null;
  const sub = mimeType.split('/')[1]?.split(';')[0]?.trim().toLowerCase();
  if (!sub || sub === 'octet-stream') return null;
  if (MIME_SUBTYPE_MAP[sub]) return MIME_SUBTYPE_MAP[sub]!;
  return sub.length <= 6 ? sub.toUpperCase() : null;
}

export interface TileFormatBadgeInfo {
  label: string;
  isSession: boolean;
  fileType: FileTileData['fileType'];
}

/**
 * 解析文件/媒体/会话磁贴右下角格式角标的展示信息（类型图标 + 真实格式缩写）
 */
export function resolveTileFormatBadge(
  file: FileTileData,
  resources?: Record<string, ExploreResource>,
): TileFormatBadgeInfo {
  const isSession = Boolean(
    file.isSessionLink ||
      file.sessionCredentialState ||
      file.extension?.toLowerCase() === 'tg',
  );
  if (isSession) {
    return {
      label: 'TG',
      isSession: true,
      fileType: file.fileType,
    };
  }

  const resource = file.resourceId && resources ? resources[file.resourceId] : undefined;
  const videoInfo = file.videoInfo ?? resource?.videoInfo;
  const photoInfo = file.photoInfo ?? resource?.photoInfo;
  const fileInfo = file.fileInfo ?? resource?.fileInfo;

  const rawExt = file.extension?.trim().toLowerCase();
  if (rawExt && rawExt !== 'msg' && rawExt !== 'bin' && rawExt !== 'tg') {
    return {
      label: rawExt.toUpperCase(),
      isSession: false,
      fileType: file.fileType,
    };
  }

  if (videoInfo || file.fileType === 'video') {
    const label =
      extractExtFromFileName(videoInfo?.fileName) ??
      extractExtFromMime(videoInfo?.mimeType) ??
      'MP4';
    return { label, isSession: false, fileType: 'video' };
  }

  if (photoInfo || file.fileType === 'image') {
    return { label: 'JPG', isSession: false, fileType: 'image' };
  }

  if (fileInfo) {
    const label =
      extractExtFromFileName(fileInfo.fileName) ??
      extractExtFromMime(fileInfo.mimeType) ??
      (rawExt ? rawExt.toUpperCase() : getFileVisual(file.fileType).badge);
    return { label, isSession: false, fileType: file.fileType };
  }

  return {
    label: rawExt ? rawExt.toUpperCase() : getFileVisual(file.fileType).badge,
    isSession: false,
    fileType: file.fileType,
  };
}
