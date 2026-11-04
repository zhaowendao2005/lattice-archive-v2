import type { ExploreManifestV2 } from '../types';
import type { FileTileData, TileData } from '@/views/main/archive/types/tile';

const stableId = (value: string) => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `res-${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

function visitTiles(list: TileData[], visit: (tile: FileTileData) => void) {
  for (const tile of list) {
    if (tile.type === 'folder') visitTiles(tile.children, visit);
    else visit(tile);
  }
}

/** 真正的会话磁贴；媒体磁贴也带 sessionId（所属会话），不能据此判定为会话。 */
function isSessionTile(tile: FileTileData): boolean {
  return Boolean(tile.isSessionLink || tile.sessionCredentialState || tile.extension?.toLowerCase() === 'tg');
}

function identityOf(tile: FileTileData): { key: string; kind: 'telegram-message' | 'telegram-session' | 'local-file' | 'note' | 'legacy' } {
  const source = tile.sources?.[0];
  const peerKey = tile.peerKey ?? source?.peerKey ?? tile.sessionId;
  const accountId = tile.accountId ?? source?.accountId ?? tile.thumb?.sourceRef?.accountId;
  if (isSessionTile(tile) && accountId && peerKey) {
    return { key: `tg-session:${accountId}:${peerKey}`, kind: 'telegram-session' };
  }
  const messageId = source?.msgId ?? tile.thumb?.sourceRef?.msgId;
  const mediaId = tile.videoInfo?.id ?? tile.photoInfo?.id ?? tile.fileInfo?.id ?? source?.documentId;
  if (accountId && peerKey && messageId) {
    return {
      key: `tg:${accountId}:${peerKey}:${messageId}:${mediaId ?? tile.fileType}`,
      kind: 'telegram-message',
    };
  }
  if (tile.filePath) return { key: `local:${tile.id}`, kind: 'local-file' };
  if (tile.content || tile.description) return { key: `note:${tile.id}`, kind: 'note' };
  return { key: `legacy:${tile.id}`, kind: 'legacy' };
}

/**
 * 修复旧版 bug：同一会话的媒体磁贴被错误并入 `telegram-session` 资源，共用同一封面。
 * 每个磁贴自己的媒体定位信息已丢失，但 sourceResultId（tg-{peerKey}-{msgId}）可还原 msgId，
 * 据此重建来源并摘掉 resourceId，由后续迁移按消息生成独立 resource；封面需重新拉取。
 */
function repairCollapsedSessionResources(manifest: ExploreManifestV2) {
  const resources = manifest.resources ?? {};
  visitTiles(manifest.tiles ?? [], (tile) => {
    const resource = tile.resourceId ? resources[tile.resourceId] : undefined;
    if (!resource || resource.kind !== 'telegram-session' || isSessionTile(tile)) return;
    const match = /^tg-(.+)-(\d+)$/.exec(tile.sourceResultId ?? '');
    if (!match || !resource.accountId) return;
    const peerKey = resource.peerKey ?? match[1]!;
    const msgId = Number(match[2]);
    tile.accountId = resource.accountId;
    tile.peerKey = peerKey;
    tile.peerType = resource.peerType;
    tile.accessHash = resource.accessHash;
    tile.sessionId = peerKey;
    tile.sources = [{
      kind: 'origin',
      accountId: resource.accountId,
      peerKey,
      peerId: peerKey.replace(/^(user|chat|channel)-/, ''),
      peerType: resource.peerType,
      accessHash: resource.accessHash,
      msgId,
    }] as FileTileData['sources'];
    tile.thumb = {
      status: 'pending',
      retryCount: 0,
      sourceRef: {
        accountId: resource.accountId,
        peerId: peerKey.replace(/^(user|chat|channel)-/, ''),
        peerType: resource.peerType,
        accessHash: resource.accessHash,
        msgId,
      },
    } as FileTileData['thumb'];
    delete tile.resourceId;
  });
}

/** Idempotently upgrades V2 manifests and de-duplicates resources without changing tile identity/layout. */
export function migrateExploreManifestV2ToV3(input: ExploreManifestV2): ExploreManifestV2 {
  const manifest = JSON.parse(JSON.stringify(input)) as ExploreManifestV2;
  repairCollapsedSessionResources(manifest);
  const resources = manifest.resources ?? {};
  const byIdentity = new Map(Object.values(resources).map((resource) => [resource.identityKey, resource]));

  visitTiles(manifest.tiles ?? [], (tile) => {
    if (tile.resourceId && resources[tile.resourceId]) return;
    const identity = identityOf(tile);
    const existing = byIdentity.get(identity.key);
    const id = existing?.id ?? stableId(identity.key);
    const ts = tile.updatedAtMs ?? Date.now();
    let resource = existing ?? {
      id,
      identityKey: identity.key,
      kind: identity.kind,
      accountId: tile.accountId ?? tile.sources?.[0]?.accountId ?? tile.thumb?.sourceRef?.accountId,
      peerKey: tile.peerKey ?? tile.sources?.[0]?.peerKey ?? tile.sessionId,
      peerType: tile.peerType ?? tile.sources?.[0]?.peerType ?? tile.thumb?.sourceRef?.peerType,
      accessHash: tile.accessHash ?? tile.sources?.[0]?.accessHash ?? tile.thumb?.sourceRef?.accessHash,
      username: tile.username,
      inviteHash: tile.inviteHash,
      sessionCredentialState: tile.sessionCredentialState,
      peekExpiresAt: tile.peekExpiresAt,
      lastVerifiedAt: tile.lastVerifiedAt,
      autoRenew: tile.autoRenew,
      participantsCount: tile.participantsCount,
      messageId: tile.sources?.[0]?.msgId ?? tile.thumb?.sourceRef?.msgId,
      mediaId: tile.videoInfo?.id ?? tile.photoInfo?.id ?? tile.fileInfo?.id ?? tile.sources?.[0]?.documentId,
      fileType: tile.fileType,
      title: tile.title,
      description: tile.description,
      photoInfo: tile.photoInfo,
      videoInfo: tile.videoInfo,
      fileInfo: tile.fileInfo,
      sources: tile.sources,
      thumb: tile.thumb ? { status: tile.thumb.status, strippedDataUrl: tile.thumb.strippedDataUrl, retryCount: tile.thumb.retryCount } : undefined,
      createdAtMs: Date.parse(`${tile.createdAt}T00:00:00Z`) || ts,
      updatedAtMs: ts,
    };
    if (existing && ts >= existing.updatedAtMs) {
      const sourceMap = new Map([...(existing.sources ?? []), ...(tile.sources ?? [])].map((source) => [JSON.stringify(source), source]));
      resource = {
        ...existing,
        title: tile.title,
        description: tile.description ?? existing.description,
        fileType: tile.fileType,
        photoInfo: tile.photoInfo ?? existing.photoInfo,
        videoInfo: tile.videoInfo ?? existing.videoInfo,
        fileInfo: tile.fileInfo ?? existing.fileInfo,
        sessionCredentialState: tile.sessionCredentialState ?? existing.sessionCredentialState,
        peekExpiresAt: tile.peekExpiresAt ?? existing.peekExpiresAt,
        lastVerifiedAt: tile.lastVerifiedAt ?? existing.lastVerifiedAt,
        autoRenew: tile.autoRenew ?? existing.autoRenew,
        participantsCount: tile.participantsCount ?? existing.participantsCount,
        sources: Array.from(sourceMap.values()),
        thumb: tile.thumb?.status === 'ready' ? {
          status: tile.thumb.status,
          strippedDataUrl: tile.thumb.strippedDataUrl,
          retryCount: tile.thumb.retryCount,
        } : existing.thumb,
        updatedAtMs: ts,
      };
    }
    resources[id] = resource;
    byIdentity.set(identity.key, resource);
    tile.resourceId = id;
  });

  manifest.resources = resources;
  manifest.schemaVersion = 3;
  return stripResourceMirrors(manifest);
}

export function materializeResourceMirrors(manifest: ExploreManifestV2): ExploreManifestV2 {
  const result = JSON.parse(JSON.stringify(manifest)) as ExploreManifestV2;
  const resources = result.resources ?? {};
  visitTiles(result.tiles, (tile) => {
    const resource = tile.resourceId ? resources[tile.resourceId] : undefined;
    if (!resource) return;
    tile.accountId = resource.accountId ?? tile.accountId;
    tile.peerKey = resource.peerKey ?? tile.peerKey;
    tile.peerType = resource.peerType ?? tile.peerType;
    tile.accessHash = resource.accessHash ?? tile.accessHash;
    tile.username = resource.username ?? tile.username;
    tile.inviteHash = resource.inviteHash ?? tile.inviteHash;
    tile.sessionId = resource.kind === 'telegram-session' || resource.kind === 'telegram-message' ? resource.peerKey ?? tile.sessionId : tile.sessionId;
    tile.sessionCredentialState = resource.sessionCredentialState ?? tile.sessionCredentialState;
    tile.peekExpiresAt = resource.peekExpiresAt ?? tile.peekExpiresAt;
    tile.lastVerifiedAt = resource.lastVerifiedAt ?? tile.lastVerifiedAt;
    tile.autoRenew = resource.autoRenew ?? tile.autoRenew;
    tile.participantsCount = resource.participantsCount ?? tile.participantsCount;
    tile.sources = resource.sources ?? tile.sources;
    tile.photoInfo = resource.photoInfo ?? tile.photoInfo;
    tile.videoInfo = resource.videoInfo ?? tile.videoInfo;
    tile.fileInfo = resource.fileInfo ?? tile.fileInfo;
    tile.description = resource.description ?? tile.description;
    if (resource.thumb) {
      tile.thumb = {
        ...resource.thumb,
        opfsPath: `/thumbs/${resource.id}.webp`,
        retryCount: resource.thumb.retryCount,
      } as FileTileData['thumb'];
    }
  });
  return result;
}

export function stripResourceMirrors(manifest: ExploreManifestV2): ExploreManifestV2 {
  const result = JSON.parse(JSON.stringify(manifest)) as ExploreManifestV2;
  visitTiles(result.tiles, (tile) => {
    if (!tile.resourceId) return;
    delete tile.accountId;
    delete tile.peerKey;
    delete tile.peerType;
    delete tile.accessHash;
    delete tile.username;
    delete tile.inviteHash;
    delete tile.sessionId;
    delete tile.sessionCredentialState;
    delete tile.peekExpiresAt;
    delete tile.lastVerifiedAt;
    delete tile.autoRenew;
    delete tile.participantsCount;
    delete tile.sources;
    delete tile.photoInfo;
    delete tile.videoInfo;
    delete tile.fileInfo;
    delete tile.thumb;
  });
  return result;
}

export function attachCanonicalResource(tile: FileTileData, resources: Record<string, import('../types').ExploreResource>): FileTileData {
  const identity = identityOf(tile);
  const current = Object.values(resources).find((resource) => resource.identityKey === identity.key);
  const id = current?.id ?? stableId(identity.key);
  const created = migrateExploreManifestV2ToV3({
    schemaVersion: 3,
    revision: 1,
    updatedAtMs: Date.now(),
    deviceId: 'local',
    groups: [],
    tiles: [tile],
    resources: current ? { [id]: current } : {},
    tombstones: {},
    tempCredentials: [],
  });
  Object.assign(resources, created.resources);
  tile.resourceId = id;
  return tile;
}

export function resourceIdForIdentity(identityKey: string): string {
  return stableId(identityKey);
}
