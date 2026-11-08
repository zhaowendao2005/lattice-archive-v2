<script setup lang="ts">
import { computed, onMounted, onUnmounted, type ComponentPublicInstance } from 'vue';
import { useRouter } from 'vue-router';
import {
  CheckSquare,
  ExternalLink,
  Folder,
  FolderInput,
  FolderOpen,
  FolderTree,
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UnfoldHorizontal,
  X,
} from '@lucide/vue';
import type { TileSize } from '../../types/tile';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useSessionManagerStore } from '@/stores/archive/stores/sessionManagerStore';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import type { TgPeerKey } from '@/stores/chat/types';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import { archiveDomRegistry } from '../../store/archiveDomRegistry';
import { isTelegramMediaTile } from '../../utils/tilePresentation';

const router = useRouter();
const tileStore = useTileStore();
const aggregateSearchStore = useAggregateSearchStore();
const sessionManagerStore = useSessionManagerStore();
const chatStore = useChatStore();

function bindMenuRef(el: Element | ComponentPublicInstance | null) {
  archiveDomRegistry.setContextMenuEl(el instanceof HTMLElement ? el : null);
}

const activeTile = computed(() => {
  if (!tileStore.contextMenu.tileId) return null;
  return tileStore.getTileById(tileStore.contextMenu.tileId);
});

const activeBlankFolder = computed(() => {
  if (tileStore.contextMenu.tileId || !tileStore.contextMenu.folderId) return null;
  const f = tileStore.getTileById(tileStore.contextMenu.folderId);
  return f && f.type === 'folder' ? f : null;
});

const batchTargetIds = computed(() => {
  const pool =
    tileStore.folderSelectedTileIds.length > 0
      ? tileStore.folderSelectedTileIds
      : tileStore.selectedTileIds;
  if (pool.length > 0) {
    if (activeTile.value && !pool.includes(activeTile.value.id)) {
      if (!activeTile.value.undeletable && !activeTile.value.systemApp) {
        return [...pool, activeTile.value.id];
      }
    }
    return pool;
  }
  if (activeTile.value && !activeTile.value.undeletable && !activeTile.value.systemApp) {
    return [activeTile.value.id];
  }
  return [];
});

const activeGroup = computed(() => {
  if (tileStore.contextMenu.tileId || tileStore.contextMenu.folderId || !tileStore.contextMenu.groupId) {
    return null;
  }
  return tileStore.groups.find(g => g.id === tileStore.contextMenu.groupId) || null;
});

const menuStyle = computed(() => {
  const x = Math.min(tileStore.contextMenu.x, window.innerWidth - 220);
  const y = Math.min(tileStore.contextMenu.y, window.innerHeight - 420);
  return {
    left: `${Math.max(10, x)}px`,
    top: `${Math.max(10, y)}px`,
  };
});

function handleBatchMoveToFolder(folderId: string) {
  if (batchTargetIds.value.length > 0) {
    tileStore.batchMoveTilesToFolder(folderId, batchTargetIds.value);
  }
  tileStore.closeContextMenu();
}

function handleOpenExplorerPicker() {
  if (batchTargetIds.value.length > 0) {
    tileStore.openExplorerPickerForTiles(batchTargetIds.value);
  }
  tileStore.closeContextMenu();
}

function handleBatchDelete() {
  const ids = [...batchTargetIds.value];
  tileStore.closeContextMenu();
  if (ids.length === 0) return;
  if (confirm(`确定要批量删除已选中的 ${ids.length} 项磁贴吗？`)) {
    tileStore.batchDeleteTiles(ids);
    tileStore.clearFolderSelectedTiles();
  }
}

function handleBatchRefreshCovers() {
  const ids = [...batchTargetIds.value];
  tileStore.closeContextMenu();
  if (ids.length === 0) return;
  void tileStore.refreshTileCoversByIds(ids);
}

function handleReloadMissingCovers() {
  const folderId = tileStore.contextMenu.folderId;
  tileStore.closeContextMenu();
  void tileStore.reloadMissingOrFailedTileCovers(folderId);
}

function handleBatchDeduplicate() {
  const ids = [...batchTargetIds.value];
  tileStore.closeContextMenu();
  if (ids.length < 2) return;
  tileStore.deduplicateTiles({ scope: 'selection', tileIds: ids });
}

function handleDeduplicateActiveFolderTile() {
  if (!activeTile.value || activeTile.value.type !== 'folder') return;
  const folderId = activeTile.value.id;
  tileStore.closeContextMenu();
  tileStore.deduplicateTiles({ scope: 'folder', folderId });
}

function handleDeduplicateGroup() {
  if (!activeGroup.value) return;
  const groupId = activeGroup.value.id;
  tileStore.closeContextMenu();
  tileStore.deduplicateTiles({ scope: 'group', groupId });
}

function handleDeduplicateScope() {
  const folderId = tileStore.contextMenu.folderId;
  tileStore.closeContextMenu();
  if (folderId) {
    tileStore.deduplicateTiles({ scope: 'folder', folderId });
  } else {
    tileStore.deduplicateTiles({ scope: 'board' });
  }
}

function handleResize(size: TileSize) {
  const ids = batchTargetIds.value;
  tileStore.closeContextMenu();
  if (ids.length === 0) return;
  tileStore.batchResizeTiles(ids, size);
}

function handleBatchMoveOutOfFolder() {
  const folderId = tileStore.contextMenu.folderId;
  const ids = [...batchTargetIds.value];
  tileStore.closeContextMenu();
  if (!folderId || ids.length === 0) return;
  tileStore.batchRemoveFilesFromFolder(folderId, ids);
  tileStore.clearFolderSelectedTiles();
}

function handleClearSelection() {
  tileStore.closeContextMenu();
  tileStore.clearSelectedTiles();
  tileStore.clearFolderSelectedTiles();
}

function handleRename() {
  if (!activeTile.value) return;
  const newName = prompt('重命名磁贴：', activeTile.value.title);
  if (newName && newName.trim()) {
    tileStore.renameTile(activeTile.value.id, newName.trim());
  }
  tileStore.closeContextMenu();
}

function handleOpenMedia() {
  const tile = activeTile.value;
  tileStore.closeContextMenu();
  if (tile?.type === 'file' && isTelegramMediaTile(tile, tileStore.resources)) void tileStore.openTelegramMedia(tile);
}

function handleOpen() {
  if (!activeTile.value) return;
  if (activeTile.value.systemApp === 'aggregate-search') {
    aggregateSearchStore.openModal();
    tileStore.closeContextMenu();
    return;
  }
  if (activeTile.value.systemApp === 'session-manager') {
    sessionManagerStore.openModal();
    tileStore.closeContextMenu();
    return;
  }
  if (activeTile.value.type === 'file') {
    tileStore.openFile(activeTile.value);
  } else if (activeTile.value.type === 'folder') {
    tileStore.openFolder(activeTile.value);
  }
  tileStore.closeContextMenu();
}

function handleJumpToSession() {
  if (!activeTile.value || activeTile.value.type !== 'file') return;
  const tile = activeTile.value;
  const src = tile.sources?.[0];
  const peerKey = (tile.peerKey ?? src?.peerKey ?? tile.sessionId) as TgPeerKey | undefined;
  const msgId = src?.msgId ?? tile.thumb?.sourceRef?.msgId;
  tileStore.closeContextMenu();
  tileStore.closeFile();
  tileStore.closeFolder();
  if (!peerKey) return;
  void chatStore.openSessionFromTile({
    peerKey,
    peerType: tile.peerType ?? src?.peerType ?? tile.thumb?.sourceRef?.peerType,
    accessHash: tile.accessHash ?? src?.accessHash ?? tile.thumb?.sourceRef?.accessHash,
    title: tile.sessionTitle || tile.title,
    username: tile.username,
    inviteHash: tile.inviteHash,
    accountId: tile.accountId ?? src?.accountId ?? tile.thumb?.sourceRef?.accountId,
    messageId: msgId,
    avatarThumb: tile.isSessionLink ? (tile.thumb?.objectUrl || tile.thumb?.strippedDataUrl) : undefined,
  });
  void router.push({ name: 'chats', params: { chatKey: peerKey } });
}

function handleUpgradeTempSession() {
  if (!activeTile.value || activeTile.value.type !== 'file') return;
  const targetKey = activeTile.value.peerKey || activeTile.value.sessionId;
  const cred = sessionManagerStore.tempCredentials.find(
    (c) => c.peerKey === targetKey || c.linkedTileIds.includes(activeTile.value!.id),
  );
  if (cred) {
    void sessionManagerStore.upgradeTempCredentialToJoined(cred.id);
  } else if (targetKey) {
    tileStore.upgradeSessionTileCredential(targetKey, 'joined');
  }
  tileStore.closeContextMenu();
}

function handleBackupToVault() {
  if (!activeTile.value || activeTile.value.type !== 'file') return;
  void sessionManagerStore.backupTileMediaToVault(activeTile.value.id);
  tileStore.closeContextMenu();
}

function handleTogglePinOffline() {
  if (!activeTile.value || activeTile.value.type !== 'file') return;
  void tileStore.togglePinOfflineAsset(activeTile.value.id);
  tileStore.closeContextMenu();
}

function handleDissolve() {
  if (!activeTile.value || activeTile.value.type !== 'folder') return;
  if (confirm(`确定要解散文件夹「${activeTile.value.title}」吗？`)) {
    tileStore.dissolveFolder(activeTile.value.id);
  }
  tileStore.closeContextMenu();
}

function handleDelete() {
  if (!activeTile.value) return;
  if (confirm(`确定要从开始屏幕移除磁贴「${activeTile.value.title}」吗？`)) {
    tileStore.deleteTile(activeTile.value.id);
  }
  tileStore.closeContextMenu();
}

function handleCreateGroup() {
  const name = prompt('请输入新分组（栏）名称：', '新建分组');
  if (name !== null) {
    tileStore.addNewGroup(name.trim() || '新建分组');
  }
  tileStore.closeContextMenu();
}

function handleRenameGroup() {
  if (!activeGroup.value) return;
  const newName = prompt('重命名分组：', activeGroup.value.title);
  if (newName && newName.trim()) {
    tileStore.renameGroup(activeGroup.value.id, newName.trim());
  }
  tileStore.closeContextMenu();
}

function handleDeleteGroup() {
  if (!activeGroup.value) return;
  if (confirm(`确定要删除分组「${activeGroup.value.title}」吗？组内磁贴将被移动至其他分组。`)) {
    tileStore.deleteGroup(activeGroup.value.id);
  }
  tileStore.closeContextMenu();
}

function handleSetGroupWidth(cols: number) {
  if (!activeGroup.value) return;
  tileStore.setGroupWidth(activeGroup.value.id, cols);
  tileStore.closeContextMenu();
}

function handleCreateFile() {
  const folderId = tileStore.contextMenu.folderId || undefined;
  const name = prompt('请输入新文件磁贴名称：', '新归档文档.md');
  if (name && name.trim()) {
    const ext = name.includes('.') ? name.split('.').pop() : 'txt';
    tileStore.addNewFile(
      {
        title: name.trim(),
        fileType: ext === 'pdf' ? 'pdf' : ext === 'md' || ext === 'doc' ? 'doc' : 'text',
        extension: ext,
      },
      tileStore.contextMenu.groupId || undefined,
      folderId,
    );
  }
  tileStore.closeContextMenu();
}

function handleCreateFolder() {
  const folderId = tileStore.contextMenu.folderId;
  const name = prompt(
    folderId ? '请输入新建子文件夹名称：' : '请输入新文件夹名称：',
    folderId ? '新建子文件夹' : '新建分类文件夹',
  );
  if (name && name.trim()) {
    if (folderId) {
      tileStore.addSubFolder(folderId, name.trim());
    } else {
      tileStore.addNewFolder(name.trim(), tileStore.contextMenu.groupId || undefined);
    }
  }
  tileStore.closeContextMenu();
}

function handleReset() {
  if (confirm('确定要恢复默认 Windows 10 磁贴布局吗？当前自定义调整将被覆盖。')) {
    tileStore.resetToDefault();
  }
  tileStore.closeContextMenu();
}

function onClickOutside(event: MouseEvent) {
  const menuEl = archiveDomRegistry.getContextMenuEl();
  if (menuEl && !menuEl.contains(event.target as Node)) {
    tileStore.closeContextMenu();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    tileStore.closeContextMenu();
  }
}

onMounted(() => {
  window.addEventListener('mousedown', onClickOutside);
  window.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  window.removeEventListener('mousedown', onClickOutside);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div
    v-if="tileStore.contextMenu.visible"
    :ref="bindMenuRef"
    class="fixed z-[9600] min-w-[215px] max-w-[275px] overflow-hidden rounded-[2px] border border-white/20 bg-[#161a22]/95 py-1 text-xs text-white shadow-2xl backdrop-blur-2xl"
    :style="menuStyle"
  >
    <!-- 0. 批量框选/多选操作区（当已选多项或对可移动磁贴右键时均可一键移入文件夹/刷新封面/批量删除） -->
    <template v-if="batchTargetIds.length > 0">
      <div class="flex items-center justify-between border-b border-white/10 bg-sky-500/15 px-3 py-1.5 text-[11px] font-semibold text-sky-200">
        <span class="flex items-center gap-1.5">
          <CheckSquare class="size-3.5 text-sky-400" />
          <span>{{ batchTargetIds.length > 1 ? `已选 ${batchTargetIds.length} 项磁贴` : '归档与目录操作' }}</span>
        </span>
      </div>

      <!-- 刷新已选磁贴封面 -->
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-emerald-300 transition-colors hover:bg-emerald-500/20"
        @click="handleBatchRefreshCovers"
      >
        <RefreshCw class="size-3.5 shrink-0 text-emerald-400" />
        <span class="truncate">
          {{ batchTargetIds.length > 1 ? `刷新已选磁贴封面 (${batchTargetIds.length} 项)` : '刷新此磁贴封面 / 重新载入贴图' }}
        </span>
      </button>

      <!-- 打开资源管理器移动/新建文件夹 -->
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 transition-colors hover:bg-sky-500/20"
        @click="handleOpenExplorerPicker"
      >
        <FolderTree class="size-3.5 shrink-0 text-sky-400" />
        <span class="truncate">{{ batchTargetIds.length > 1 ? '批量移动到文件夹 (资源管理器)…' : '移动到文件夹 (资源管理器)…' }}</span>
      </button>

      <!-- 快捷文件夹直达列表 -->
      <div v-if="tileStore.allFoldersFlat.length > 0" class="max-h-28 overflow-y-auto border-y border-white/5 bg-black/25 py-0.5">
        <div class="px-3 py-0.5 text-[9px] uppercase tracking-wider text-white/35">
          快捷移入文件夹
        </div>
        <button
          v-for="folder in tileStore.allFoldersFlat.slice(0, 6)"
          :key="folder.id"
          type="button"
          class="flex w-full items-center gap-1.5 px-3 py-1 text-left text-[11px] text-white/75 transition-colors hover:bg-white/10 hover:text-amber-200"
          @click="handleBatchMoveToFolder(folder.id)"
        >
          <FolderInput class="size-3 shrink-0 text-amber-400/85" />
          <span class="truncate">{{ folder.pathLabel }}</span>
        </button>
      </div>

      <button
        v-if="batchTargetIds.length > 1"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 transition-colors hover:bg-sky-500/20"
        @click="handleBatchDeduplicate"
      >
        <Sparkles class="size-3.5 shrink-0 text-sky-400" />
        <span>清理已选中的重复磁贴 ({{ batchTargetIds.length }} 项)</span>
      </button>

      <button
        v-if="batchTargetIds.length > 1"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 transition-colors hover:bg-rose-500/20"
        @click="handleBatchDelete"
      >
        <Trash2 class="size-3.5 shrink-0 text-rose-400" />
        <span>批量删除已选 ({{ batchTargetIds.length }} 项)</span>
      </button>

      <button
        v-if="tileStore.contextMenu.folderId"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 transition-colors hover:bg-sky-500/20"
        @click="handleBatchMoveOutOfFolder"
      >
        <UnfoldHorizontal class="size-3.5 shrink-0 text-sky-400" />
        <span>移出到磁贴板{{ batchTargetIds.length > 1 ? ` (${batchTargetIds.length} 项)` : '' }}</span>
      </button>

      <button
        v-if="batchTargetIds.length > 1"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/70 transition-colors hover:bg-white/10"
        @click="handleClearSelection"
      >
        <X class="size-3.5 shrink-0 text-white/50" />
        <span>取消选择</span>
      </button>

      <div class="my-1 border-t border-white/10" />
    </template>

    <!-- 1. Tile Specific Actions -->
    <template v-if="activeTile">
      <!-- Title header -->
      <div class="px-3 py-1.5 text-[11px] font-semibold text-white/50 truncate border-b border-white/10">
        {{ activeTile.title }}
      </div>

      <!-- Resize Submenu -->
      <div class="px-1 py-1">
        <div class="px-2 py-1 text-[10px] uppercase tracking-wider text-white/40">
          {{ batchTargetIds.length > 1 ? `批量调整大小 (${batchTargetIds.length} 项)` : '调整大小' }}
        </div>
        <div class="grid grid-cols-3 gap-1 px-1">
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'small' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="小 (2×2)"
            @click="handleResize('small')"
          >
            <Minimize2 class="size-3" />
            <span class="mt-0.5">小</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'medium' || activeTile.size === 'wide' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="中 (3×3)"
            @click="handleResize('medium')"
          >
            <Square class="size-3" />
            <span class="mt-0.5">中</span>
          </button>
          <button
            type="button"
            class="flex flex-col items-center justify-center rounded p-1 text-[10px] hover:bg-white/10 transition-colors"
            :class="activeTile.size === 'large' ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70'"
            title="大 (4×4)"
            @click="handleResize('large')"
          >
            <Maximize2 class="size-3" />
            <span class="mt-0.5">大</span>
          </button>
        </div>
      </div>

      <div class="my-1 border-t border-white/10" />

      <!-- Open / Preview -->
      <button
        v-if="activeTile.type === 'file' && isTelegramMediaTile(activeTile, tileStore.resources)"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-200 hover:bg-white/10 transition-colors"
        @click="handleOpenMedia"
      >
        <ExternalLink class="size-3.5 text-sky-300" />
        <span>打开</span>
      </button>
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleOpen"
      >
        <ExternalLink class="size-3.5 text-white/60" />
        <span>
          {{
            activeTile.systemApp === 'aggregate-search'
              ? '打开聚合搜索系统'
              : activeTile.systemApp === 'session-manager'
                ? '打开会话与配额管理器'
                : activeTile.type === 'folder'
                  ? '展开文件夹'
                  : '详情'
          }}
        </span>
      </button>

      <!-- Jump to Chat Session / Source Message -->
      <button
        v-if="activeTile.type === 'file' && (activeTile.peerKey || activeTile.sessionId || activeTile.sources?.length)"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 hover:bg-white/10 transition-colors"
        @click="handleJumpToSession"
      >
        <MessageSquare class="size-3.5 text-sky-400" />
        <span>{{ activeTile.sources?.length ? '定位至源会话消息' : '跳转至会话阅读流' }}</span>
      </button>

      <!-- Upgrade Temp Credential to Joined -->
      <button
        v-if="activeTile.type === 'file' && activeTile.sessionCredentialState && activeTile.sessionCredentialState !== 'joined'"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-emerald-300 hover:bg-white/10 transition-colors"
        @click="handleUpgradeTempSession"
      >
        <Sparkles class="size-3.5 text-emerald-400" />
        <span>转正为已加入并静默归档</span>
      </button>

      <!-- Backup to Shared Private Vault -->
      <button
        v-if="activeTile.type === 'file' && activeTile.sources?.length && !activeTile.hasVaultCopy"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-indigo-300 hover:bg-white/10 transition-colors"
        @click="handleBackupToVault"
      >
        <ShieldCheck class="size-3.5 text-indigo-400" />
        <span>{{ activeTile.noforwards ? '流式克隆至共享备份群' : '零带宽转发至共享备份群' }}</span>
      </button>

      <!-- Pin Offline Asset -->
      <button
        v-if="activeTile.type === 'file' && !activeTile.systemApp"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleTogglePinOffline"
      >
        <Pin class="size-3.5 text-amber-400" />
        <span>{{ activeTile.pinnedOffline ? '取消钉选离线原片' : '钉选离线原片 (永不驱逐)' }}</span>
      </button>

      <!-- Rename -->
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleRename"
      >
        <Pencil class="size-3.5 text-white/60" />
        <span>重命名</span>
      </button>

      <!-- Deduplicate Folder (for folder tile) -->
      <button
        v-if="activeTile.type === 'folder'"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 hover:bg-sky-500/20 transition-colors"
        @click="handleDeduplicateActiveFolderTile"
      >
        <Sparkles class="size-3.5 text-sky-400" />
        <span>清理文件夹内重复磁贴 (按 TG ID)</span>
      </button>

      <!-- Dissolve (for folder) -->
      <button
        v-if="activeTile.type === 'folder'"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleDissolve"
      >
        <UnfoldHorizontal class="size-3.5 text-white/60" />
        <span>解散文件夹</span>
      </button>

      <div class="my-1 border-t border-white/10" />

      <!-- Delete / Unpin (Hidden for undeletable system app tiles) -->
      <button
        v-if="!activeTile.undeletable && !activeTile.systemApp"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/20 transition-colors"
        @click="handleDelete"
      >
        <Trash2 class="size-3.5 text-rose-400" />
        <span>从磁贴板移除</span>
      </button>
      <div
        v-else
        class="px-3 py-1.5 text-[10px] font-mono text-sky-300/65 select-none"
      >
        系统常驻磁贴 · 不可删除
      </div>
    </template>

    <!-- 2. Group Header Context Actions -->
    <template v-else-if="activeGroup">
      <div class="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-sky-200 truncate border-b border-white/10 bg-sky-500/10">
        <LayoutGrid class="size-3.5 shrink-0 text-sky-400" />
        <span class="truncate">分组：{{ activeGroup.title }}</span>
      </div>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleRenameGroup"
      >
        <Pencil class="size-3.5 text-white/60" />
        <span>重命名分组</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 hover:bg-sky-500/20 transition-colors"
        @click="handleDeduplicateGroup"
      >
        <Sparkles class="size-3.5 text-sky-400" />
        <span>清理此分组重复磁贴 (按 TG ID)</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFile"
      >
        <Plus class="size-3.5 text-sky-400" />
        <span>在此组新建文件</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFolder"
      >
        <FolderOpen class="size-3.5 text-amber-400" />
        <span>在此组新建文件夹</span>
      </button>

      <!-- Group Width Setting -->
      <div class="my-1 border-t border-white/10" />
      <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-white/40">栏宽度设置</div>
      <div class="grid grid-cols-3 gap-1 px-2 py-0.5">
        <button
          v-for="w in [4, 6, 8]"
          :key="w"
          type="button"
          class="rounded py-1 text-center text-[10px] transition-colors"
          :class="(activeGroup.widthColumns || 6) === w ? 'bg-sky-500/30 text-sky-300 font-semibold' : 'text-white/70 hover:bg-white/10'"
          @click="handleSetGroupWidth(w)"
        >
          {{ w }} 列
        </button>
      </div>

      <div class="my-1 border-t border-white/10" />

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-rose-400 hover:bg-rose-500/20 transition-colors"
        @click="handleDeleteGroup"
      >
        <Trash2 class="size-3.5 text-rose-400" />
        <span>删除此分组</span>
      </button>
    </template>

    <!-- 3. Folder Blank Area or Empty Canvas / Board Actions -->
    <template v-else>
      <div
        v-if="activeBlankFolder"
        class="flex items-center gap-1.5 border-b border-white/10 bg-amber-500/10 px-3 py-1.5 text-[11px] font-semibold text-amber-200 truncate"
      >
        <Folder class="size-3.5 shrink-0 text-amber-400" />
        <span class="truncate">文件夹：{{ activeBlankFolder.title }}</span>
      </div>

      <button
        v-if="!activeBlankFolder"
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/95 hover:bg-white/10 transition-colors"
        @click="handleCreateGroup"
      >
        <LayoutGrid class="size-3.5 text-sky-400" />
        <span class="font-medium text-sky-300">新建分组（栏）</span>
      </button>

      <div v-if="!activeBlankFolder" class="my-1 border-t border-white/10" />

      <div class="px-3 py-1 text-[10px] uppercase tracking-wider text-white/40">新增与贴图维护</div>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sky-300 hover:bg-sky-500/20 transition-colors"
        @click="handleDeduplicateScope"
      >
        <Sparkles class="size-3.5 shrink-0 text-sky-400" />
        <span>{{ activeBlankFolder ? '清理此文件夹重复磁贴 (按 TG ID)' : '清理全板重复磁贴 (按 TG ID)' }}</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-emerald-300 hover:bg-emerald-500/20 transition-colors"
        @click="handleReloadMissingCovers"
      >
        <RefreshCw class="size-3.5 shrink-0 text-emerald-400" />
        <span>重新载入加载失败/缺失的贴图</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFile"
      >
        <Plus class="size-3.5 text-white/60" />
        <span>{{ activeBlankFolder ? '在此文件夹新建文件' : '新建文件磁贴' }}</span>
      </button>

      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/85 hover:bg-white/10 transition-colors"
        @click="handleCreateFolder"
      >
        <FolderOpen class="size-3.5 text-amber-400" />
        <span>{{ activeBlankFolder ? '在此文件夹新建子文件夹' : '新建文件夹' }}</span>
      </button>

      <template v-if="!activeBlankFolder">
        <div class="my-1 border-t border-white/10" />

        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-white/70 hover:bg-white/10 transition-colors"
          @click="handleReset"
        >
          <RotateCcw class="size-3.5 text-white/50" />
          <span>恢复默认布局</span>
        </button>
      </template>
    </template>
  </div>
</template>
