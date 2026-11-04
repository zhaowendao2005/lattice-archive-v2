import type { TileData } from '../types/tile';
import type { ExploreResource } from '@/stores/archive/types';

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
