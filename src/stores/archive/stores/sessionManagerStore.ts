/**
 * [STORE] 会话与配额管理器 Store (SessionManagerStore)
 *
 * 负责四大核心治理面板与后台任务/配额 HUD：
 * 1. 全部会话与批量收纳（一键静默入群 + Telegram 侧 folder_id=1 归档 + 探索页入夹）
 * 2. 临时会话凭据池（免打扰只读窥视 / 自动续期巡检 / 一键转正）
 * 3. 多账号凭据矩阵、6 步同机回环 PendingSlot 裂变、二进制 .session 批量导入与自适应配额令牌桶
 * 4. 共享私有备份群（5 大 Forum Topics + 防转发流式克隆 + 信标同步）与 OPFS 5 子域存储配额治理
 */
import { defineStore } from 'pinia';
import type {
  AccountCredentialGovernanceRecord,
  AggregateSearchResultItem,
  BackgroundTaskItem,
  CloudSyncState,
  PendingSlotRecord,
  QuotaRuleItem,
  QuotaRuleKey,
  SharedVaultGroupConfig,
  StorageSubDomainId,
  StorageSubDomainQuota,
  SyncIntervalMode,
  TempSessionCredential,
  UserQuotaPolicyConfig,
} from '../types';
import { opfsExploreStorage } from '../data-sources/opfsExploreStorage';
import { storageQuotaEvictor } from '../data-sources/storageQuotaEvictor';
import { sessionBatchImporter } from '../data-sources/sessionBatchImporter';
import { exploreSyncEngine } from '../data-sources/exploreSyncEngine';
import { useAggregateSearchStore } from './aggregateSearchStore';
import { useTileStore } from '@/views/main/archive/store/tileStore';
import type { SessionCredentialState } from '@/views/main/archive/types/tile';
import { useChatStore } from '@/stores/chat/stores/chatStore';
import { useChatMediaStore } from '@/stores/chat/stores/chatMediaStore';
import { chatDataSource } from '@/stores/chat/data-sources/chatDataSource';
import { useTelegramStore } from '@/stores/telegram/stores/telegramStore';
import { tgSessionVault } from '@/stores/telegram/data-sources/tgSessionVault';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';
import type { TgDialogDto, TgPeerKey, TgPeerRef } from '@/stores/chat/types';

const CLOUD_SYNC_META_KEY = 'lattice_cloud_sync_meta_v2';

function readPersistedSyncMeta(): { lastSyncedRevision: number; lastSyncedAtMs: number | null } {
  if (typeof localStorage === 'undefined') {
    return { lastSyncedRevision: 0, lastSyncedAtMs: null };
  }
  try {
    const raw = localStorage.getItem(CLOUD_SYNC_META_KEY);
    if (!raw) return { lastSyncedRevision: 0, lastSyncedAtMs: null };
    const parsed = JSON.parse(raw) as { lastSyncedRevision?: number; lastSyncedAtMs?: number | null };
    return {
      lastSyncedRevision: typeof parsed.lastSyncedRevision === 'number' ? parsed.lastSyncedRevision : 0,
      lastSyncedAtMs: typeof parsed.lastSyncedAtMs === 'number' ? parsed.lastSyncedAtMs : null,
    };
  } catch {
    return { lastSyncedRevision: 0, lastSyncedAtMs: null };
  }
}

function writePersistedSyncMeta(lastSyncedRevision: number, lastSyncedAtMs: number | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      CLOUD_SYNC_META_KEY,
      JSON.stringify({ lastSyncedRevision, lastSyncedAtMs }),
    );
  } catch {
    // ignore storage quota errors
  }
}

export type SessionManagerTab = 'sessions' | 'temp_pool' | 'accounts_quota' | 'vault_storage';
export type QuotaPolicyPreset = 'conservative' | 'standard' | 'aggressive' | 'custom';

const PRESET_LIMITS: Record<
  'conservative' | 'standard' | 'aggressive',
  Record<QuotaRuleKey, { maxPerDay: number; minIntervalMs: number }>
> = {
  conservative: {
    joinChannel: { maxPerDay: 8, minIntervalMs: 60_000 },
    checkChatInvite: { maxPerDay: 25, minIntervalMs: 8_000 },
    resolveUsername: { maxPerDay: 40, minIntervalMs: 5_000 },
    botCallbackPage: { maxPerDay: 120, minIntervalMs: 2_200 },
    messagesSearch: { maxPerDay: 200, minIntervalMs: 1_000 },
  },
  standard: {
    joinChannel: { maxPerDay: 20, minIntervalMs: 30_000 },
    checkChatInvite: { maxPerDay: 60, minIntervalMs: 4_000 },
    resolveUsername: { maxPerDay: 100, minIntervalMs: 3_000 },
    botCallbackPage: { maxPerDay: 300, minIntervalMs: 1_500 },
    messagesSearch: { maxPerDay: 500, minIntervalMs: 500 },
  },
  aggressive: {
    joinChannel: { maxPerDay: 45, minIntervalMs: 12_000 },
    checkChatInvite: { maxPerDay: 150, minIntervalMs: 2_000 },
    resolveUsername: { maxPerDay: 240, minIntervalMs: 1_500 },
    botCallbackPage: { maxPerDay: 800, minIntervalMs: 1_000 },
    messagesSearch: { maxPerDay: 1200, minIntervalMs: 300 },
  },
};

export const QUOTA_RULE_LABELS: Record<QuotaRuleKey, string> = {
  joinChannel: '每日自动入群/频道上限 (channels.JoinChannel)',
  checkChatInvite: '每日私有链接探测上限 (messages.CheckChatInvite)',
  resolveUsername: '每日公开用户名解析上限 (contacts.ResolveUsername)',
  botCallbackPage: '搜索机器人自动翻页上限 (GetBotCallbackAnswer)',
  messagesSearch: 'MTProto 检索请求上限 (messages.Search)',
};

function buildDefaultRules(mode: 'conservative' | 'standard' | 'aggressive' = 'standard'): Record<QuotaRuleKey, QuotaRuleItem> {
  const base = PRESET_LIMITS[mode];
  const keys: QuotaRuleKey[] = [
    'joinChannel',
    'checkChatInvite',
    'resolveUsername',
    'botCallbackPage',
    'messagesSearch',
  ];
  const out = {} as Record<QuotaRuleKey, QuotaRuleItem>;
  for (const k of keys) {
    out[k] = {
      key: k,
      label: QUOTA_RULE_LABELS[k],
      apiMethodDesc: k,
      maxCount: base[k].maxPerDay,
      windowMinutes: 1440,
      minIntervalMs: base[k].minIntervalMs,
      jitterMs: 500,
      usedByAccount: {},
    };
  }
  return out;
}

export const useSessionManagerStore = defineStore('sessionManager', {
  state: () => {
    const syncMeta = readPersistedSyncMeta();
    return {
      isModalOpen: false,
      activeTab: 'sessions' as SessionManagerTab,
      isLeftTreeOpen: true,

      // Tab 1: 全部会话与批量收纳
      selectedPeerKeys: [] as string[],
      lastClickedPeerIndex: null as number | null,
      sessionFilterKeyword: '',
      sessionFilterMode: 'all' as 'all' | 'joined' | 'archived' | 'temp',
      targetGroupId: 'group-common',
      targetFolderId: '' as string,
      archiveInTelegram: true,
      credentialModeForPlacement: 'joined' as SessionCredentialState,
      isBatchPlacing: false,
      batchPlaceNotice: null as string | null,

      // Tab 2: 临时会话凭据池
      tempCredentials: [] as TempSessionCredential[],
      newCredentialInput: '',
      newCredentialAutoRenew: true,
      newCredentialPlaceToBoard: true,
      isAddingCredential: false,
      isPatrollingPool: false,
      patrolNotice: null as string | null,

      // Tab 3: 多账号凭据矩阵、无缝导入与配额引擎
      governanceRecords: {} as Record<string, AccountCredentialGovernanceRecord>,
      quotaPolicy: {
        mode: 'standard',
        globalConcurrency: 2,
        autoRotateAccount: true,
        pauseOnFloodWait: true,
        rules: buildDefaultRules('standard'),
      } as UserQuotaPolicyConfig,
      quotaUsageToday: {} as Record<string, Record<QuotaRuleKey, number>>,
      lastActionTimestamps: {} as Record<string, Record<QuotaRuleKey, number>>,
      floodWaitUntil: {} as Record<string, number>,
      spawn2FAPasswordInput: '',
      isSpawningSlot: {} as Record<string, boolean>,
      isProbingHealth: false,
      batchImportTextInput: '',
      isBatchImporting: false,
      batchImportNotice: null as string | null,

      // Tab 4: 共享私有备份群 & OPFS 5 子域存储治理
      vaultConfig: null as SharedVaultGroupConfig | null,
      selectedVaultPeerKey: '',
      isInitializingVault: false,
      isSyncingBeacon: false,
      vaultNotice: null as string | null,
      storageSubDomains: [] as StorageSubDomainQuota[],
      totalStorageUsedBytes: 0,
      isPersistedStorage: false,
      isCleaningStorage: false,

      // 全局任务与配额 HUD
      tasks: [] as BackgroundTaskItem[],
      isHudExpanded: false,

      // Phase 5: 单行 Gzip 云同步与 CRDT 三路合并状态
      cloudSync: {
        status: 'idle',
        syncInterval: 'manual',
        lastSyncedRevision: syncMeta.lastSyncedRevision,
        lastSyncedAtMs: syncMeta.lastSyncedAtMs,
        lastPayloadBytes: 0,
        errorMessage: null,
      } as CloudSyncState,
    };
  },

  getters: {
    filteredDialogs(state): TgDialogDto[] {
      const chatStore = useChatStore();
      const all = Object.values(chatStore.dialogs);
      const kw = state.sessionFilterKeyword.trim().toLowerCase();
      return all.filter((d) => {
        if (state.sessionFilterMode === 'joined' && (d.folderId ?? 0) !== 0) return false;
        if (state.sessionFilterMode === 'archived' && (d.folderId ?? 0) !== 1) return false;
        if (state.sessionFilterMode === 'temp') return false;
        if (!kw) return true;
        return (
          d.title.toLowerCase().includes(kw) ||
          (d.username?.toLowerCase().includes(kw) ?? false)
        );
      });
    },

    candidateVaultSupergroups(): TgDialogDto[] {
      const chatStore = useChatStore();
      return Object.values(chatStore.dialogs).filter(
        (d) => (d.kind === 'supergroup' || d.kind === 'channel') && !d.left && !d.kicked,
      );
    },

    activeTasks(state): BackgroundTaskItem[] {
      return state.tasks.filter((t) => t.status === 'running' || t.status === 'paused');
    },

    effectiveQuotaLimits(state): Record<QuotaRuleKey, { maxPerDay: number; minIntervalMs: number }> {
      const presetKey = state.quotaPolicy.mode === 'custom' ? 'standard' : state.quotaPolicy.mode;
      const base = PRESET_LIMITS[presetKey] ?? PRESET_LIMITS.standard;
      const result = { ...base };
      const keys: QuotaRuleKey[] = [
        'joinChannel',
        'checkChatInvite',
        'resolveUsername',
        'botCallbackPage',
        'messagesSearch',
      ];
      for (const k of keys) {
        const custom = state.quotaPolicy.rules?.[k];
        if (custom) {
          result[k] = {
            maxPerDay: custom.maxCount ?? base[k].maxPerDay,
            minIntervalMs: custom.minIntervalMs ?? base[k].minIntervalMs,
          };
        }
      }
      return result;
    },
  },

  actions: {
    openModal(tab?: SessionManagerTab) {
      if (tab) this.activeTab = tab;
      this.isModalOpen = true;
      const tileStore = useTileStore();
      const searchStore = useAggregateSearchStore();
      if (searchStore.expandedGroupIds.length === 0) {
        searchStore.expandAllTreeNodes();
      }
      if (tileStore.groups.length > 0 && !tileStore.groups.some((g) => g.id === this.targetGroupId)) {
        this.targetGroupId = tileStore.groups[0]!.id;
      }
      void this.hydrateFromOpfs();
      void this.refreshStorageQuotaDashboard();
    },

    closeModal() {
      const searchStore = useAggregateSearchStore();
      searchStore.cancelDragToTree();
      searchStore.closeTreeContextMenu();
      searchStore.cancelTreeInlineRename();
      this.isModalOpen = false;
    },

    toggleLeftTree() {
      this.isLeftTreeOpen = !this.isLeftTreeOpen;
    },

    selectTargetFromExplorer(payload: {
      type: 'group' | 'folder';
      id: string;
      groupId: string;
      title: string;
    }) {
      if (payload.type === 'folder') {
        this.targetGroupId = payload.groupId;
        this.targetFolderId = payload.id;
      } else {
        this.targetGroupId = payload.id;
        this.targetFolderId = '';
      }
    },

    setActiveTab(tab: SessionManagerTab) {
      this.activeTab = tab;
      if (tab === 'vault_storage') {
        void this.refreshStorageQuotaDashboard();
      } else if (tab === 'accounts_quota') {
        void this.probeAllAccountsHealth();
      }
    },

    async hydrateFromOpfs() {
      const manifest = await opfsExploreStorage.readManifest();
      if (!manifest) return;
      if (manifest.tempCredentials) {
        this.tempCredentials = manifest.tempCredentials;
      }
      if (manifest.quotaPolicy) {
        this.quotaPolicy = manifest.quotaPolicy;
      }
      if (manifest.vaultConfig) {
        this.vaultConfig = manifest.vaultConfig;
        this.selectedVaultPeerKey = manifest.vaultConfig.vaultPeerKey;
      }
    },

    async persistGovernanceToOpfs() {
      const tileStore = useTileStore();
      tileStore.tempCredentials = this.tempCredentials;
      if (this.vaultConfig) {
        tileStore.vaultConfig = this.vaultConfig;
      }
      const manifest = tileStore.buildExploreManifest();
      manifest.quotaPolicy = this.quotaPolicy;
      await opfsExploreStorage.writeManifest(manifest);
    },

    // =========================================================================
    // Tab 1: 全部会话与批量收纳
    // =========================================================================
    toggleSelectPeer(key: string) {
      const idx = this.selectedPeerKeys.indexOf(key);
      if (idx >= 0) this.selectedPeerKeys.splice(idx, 1);
      else this.selectedPeerKeys.push(key);
    },

    handleSessionCardClick(index: number, key: string, event: MouseEvent) {
      const list = this.filteredDialogs;
      if (event.shiftKey && this.lastClickedPeerIndex !== null && list.length > 0) {
        const start = Math.max(0, Math.min(this.lastClickedPeerIndex, index));
        const end = Math.min(list.length - 1, Math.max(this.lastClickedPeerIndex, index));
        const rangeKeys = list.slice(start, end + 1).map((d) => d.key);
        this.selectedPeerKeys = Array.from(new Set([...this.selectedPeerKeys, ...rangeKeys]));
        return;
      }
      this.toggleSelectPeer(key);
      this.lastClickedPeerIndex = index;
    },

    selectAllFilteredPeers() {
      const keys = this.filteredDialogs.map((d) => d.key);
      this.selectedPeerKeys = Array.from(new Set([...this.selectedPeerKeys, ...keys]));
    },

    clearSelectedPeers() {
      this.selectedPeerKeys = [];
      this.lastClickedPeerIndex = null;
    },

    /**
     * 将选中的会话卡片直接拖拽至左侧通用资源管理器树（Explore Tree）进行归档
     */
    startDragSessionCardToTree(originDialog: TgDialogDto, clientX: number, clientY: number) {
      if (!this.selectedPeerKeys.includes(originDialog.key)) {
        this.selectedPeerKeys = [originDialog.key];
      }
      if (!this.isLeftTreeOpen) {
        this.isLeftTreeOpen = true;
      }
      const chatStore = useChatStore();
      const chatMediaStore = useChatMediaStore();
      const searchStore = useAggregateSearchStore();

      const dialogsToDrag = this.filteredDialogs.filter((d) =>
        this.selectedPeerKeys.includes(d.key),
      );
      if (dialogsToDrag.length === 0) {
        dialogsToDrag.push(originDialog);
      }

      const items: AggregateSearchResultItem[] = dialogsToDrag.map((d) => {
        const avatarThumb = chatMediaStore.dialogAvatarUrl(d.key) ?? d.avatar?.thumb ?? '';
        const kindLabel =
          d.kind === 'channel'
            ? '频道'
            : d.kind === 'supergroup'
              ? '超级群'
              : d.kind === 'group'
                ? '群组'
                : d.kind === 'bot'
                  ? '机器人'
                  : '私聊';
        return {
          id: d.key,
          title: d.title,
          snippet: d.lastMessage?.text || (d.username ? `@${d.username}` : `${kindLabel}会话`),
          category: 'session',
          categoryLabel: kindLabel,
          fileType: 'generic',
          extension: 'TG',
          fileSize: d.participantsCount ? `${d.participantsCount} 成员` : kindLabel,
          sessionId: d.key,
          sessionTitle: d.title,
          sessionKind: 'joined',
          updatedAt: d.date
            ? new Date(d.date * 1000).toISOString().slice(0, 10)
            : new Date().toISOString().slice(0, 10),
          badgeMeta: kindLabel,
          thumbnailUrl: avatarThumb,
          peerRef: d.peer,
          originAccountId: chatStore.accountId ?? undefined,
        };
      });

      searchStore.dragToTree = {
        isDragging: true,
        items,
        pointerX: clientX,
        pointerY: clientY,
        hoverTargetType: null,
        hoverTargetId: null,
        hoverTargetTitle: null,
      };
    },

    async batchPlaceSelectedSessionsIntoExplore() {
      if (this.selectedPeerKeys.length === 0) {
        this.batchPlaceNotice = '请先勾选至少一个要收纳的会话';
        return;
      }
      this.isBatchPlacing = true;
      this.batchPlaceNotice = null;
      const chatStore = useChatStore();
      const chatMediaStore = useChatMediaStore();
      const tileStore = useTileStore();
      const targetGroup = tileStore.groups.find((g) => g.id === this.targetGroupId) ?? tileStore.groups[0];
      if (!targetGroup) {
        this.isBatchPlacing = false;
        this.batchPlaceNotice = '未找到目标探索分组';
        return;
      }

      const taskId = this.enqueueTask({
        kind: 'batch_join_archive',
        title: `批量收纳 ${this.selectedPeerKeys.length} 个会话至「${targetGroup.title}」`,
        total: this.selectedPeerKeys.length,
      });

      const peersToArchive: TgPeerRef[] = [];
      let placedCount = 0;

      try {
        const placedTileIds: string[] = [];
        for (const key of this.selectedPeerKeys) {
          const dialog = chatStore.dialogs[key as TgPeerKey];
          if (!dialog) continue;

          const liveAvatar = chatMediaStore.dialogAvatarUrl(dialog.key);
          // 只持久化可跨会话保留的 Data URL 占位图；blob: 链接刷新即失效
          const avatarThumb =
            dialog.avatar?.thumb ?? (liveAvatar && !liveAvatar.startsWith('blob:') ? liveAvatar : undefined);

          const placedTile = tileStore.addNewFile(
            {
              title: dialog.title,
              size: 'medium',
              fileType: 'generic',
              extension: 'tg',
              description: dialog.lastMessage?.text || (dialog.username ? `@${dialog.username}` : 'Telegram 会话'),
              sourceResultId: dialog.key,
              sessionId: dialog.key,
              sessionTitle: dialog.title,
              isSessionLink: true,
              accountId: chatStore.accountId ?? undefined,
              peerKey: dialog.key,
              peerType: dialog.peer.type,
              accessHash: dialog.peer.accessHash,
              username: dialog.username,
              sessionCredentialState: this.credentialModeForPlacement,
              unreadCount: dialog.unreadCount,
              participantsCount: dialog.participantsCount,
              archivedInTg: this.archiveInTelegram,
              thumb: avatarThumb
                ? {
                    status: 'pending',
                    strippedDataUrl: avatarThumb,
                    retryCount: 0,
                  }
                : undefined,
            },
            targetGroup.id,
            this.targetFolderId || undefined,
          );
          if (placedTile?.id) placedTileIds.push(placedTile.id);

          if (this.archiveInTelegram && dialog.kind !== 'self' && (dialog.folderId ?? 0) === 0) {
            peersToArchive.push(dialog.peer);
            chatStore.dialogs[dialog.key] = { ...dialog, folderId: 1 };
          }
          placedCount += 1;
          this.updateTaskProgress(taskId, placedCount);
        }

        if (placedTileIds.length > 0) {
          tileStore.scheduleTileCoverRefresh(placedTileIds, 'session_batch_place');
        }

        if (this.archiveInTelegram && peersToArchive.length > 0 && chatStore.accountId) {
          await chatDataSource.batchSetDialogsArchived(chatStore.accountId, peersToArchive, true);
        }

        debugLoggerDataSource.emitFrontendLog({
          domain: 'session.manager',
          level: 'INFO',
          action: 'batch_place_sessions',
          tags: {
            count: placedCount,
            targetGroupId: targetGroup.id,
            targetFolderId: this.targetFolderId || 'root',
            archivedInTg: this.archiveInTelegram,
          },
        });

        this.selectedPeerKeys = [];
        this.completeTask(taskId);
        this.batchPlaceNotice = `已成功将 ${placedCount} 个会话收纳至探索页${this.archiveInTelegram ? '，并在 Telegram 侧静默归档' : ''}`;
      } catch (err) {
        this.failTask(taskId, err instanceof Error ? err.message : '批量收纳失败');
        this.batchPlaceNotice = err instanceof Error ? err.message : '批量收纳过程中发生错误';
      } finally {
        this.isBatchPlacing = false;
      }
    },

    // =========================================================================
    // Tab 2: 临时会话凭据池
    // =========================================================================
    async addTempCredentialsFromInput() {
      const raw = this.newCredentialInput.trim();
      if (!raw) {
        this.patrolNotice = '请输入至少一个公开 @username 或 t.me/+inviteHash 链接';
        return;
      }
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      if (!accountId) {
        this.patrolNotice = '请先连接至少一个 Telegram 账号以解析临时凭据';
        return;
      }

      this.isAddingCredential = true;
      this.patrolNotice = null;
      const lines = raw.split(/[\r\n,\s]+/).map((s) => s.trim()).filter(Boolean);
      const tileStore = useTileStore();
      const targetGroup = tileStore.groups.find((g) => g.id === this.targetGroupId) ?? tileStore.groups[0];
      let addedCount = 0;

      try {
        for (const item of lines) {
          const inviteMatch = /(?:t\.me\/(?:\+|joinchat\/)|^\+)([a-zA-Z0-9_-]+)/i.exec(item);
          if (inviteMatch) {
            const hash = inviteMatch[1]!;
            const check = this.consumeQuota(accountId, 'checkChatInvite', 1);
            if (!check.allowed) {
              this.patrolNotice = check.reason ?? '配额受限';
              break;
            }
            const preview = await chatDataSource.checkChatInvite(accountId, hash);
            const credId = `temp-invite-${hash}`;
            const peerKey = preview.dialog?.key ?? `invite-${hash}`;
            const cred: TempSessionCredential = {
              id: credId,
              peerKey,
              peerId: preview.dialog?.peer.id ?? hash,
              peerType: 'channel',
              title: preview.title,
              inviteHash: hash,
              accessHash: preview.dialog?.peer.accessHash,
              accountId,
              state: this.newCredentialAutoRenew ? 'temp_auto_renew' : 'temp_ephemeral',
              autoRenew: this.newCredentialAutoRenew,
              lastVerifiedAt: Date.now(),
              peekExpiresAt: preview.peekExpiresAt ? preview.peekExpiresAt * 1000 : Date.now() + 24 * 3600_000,
              participantsCount: preview.participantsCount,
              about: preview.about,
              linkedTileIds: [],
              status: 'healthy',
            };
            this.upsertTempCredential(cred);
            if (this.newCredentialPlaceToBoard && targetGroup) {
              this.placeTempCredentialTile(cred, targetGroup.id);
            }
            addedCount += 1;
          } else {
            const cleanUsername = item.replace(/^(?:https?:\/\/)?(?:t\.me\/|@)/i, '').split(/[/?#]/)[0];
            if (!cleanUsername) continue;
            const check = this.consumeQuota(accountId, 'resolveUsername', 1);
            if (!check.allowed) {
              this.patrolNotice = check.reason ?? '配额受限';
              break;
            }
            const dialog = await chatDataSource.resolveUsername(accountId, cleanUsername);
            if (!dialog) continue;
            const credId = `temp-user-${dialog.key}`;
            const cred: TempSessionCredential = {
              id: credId,
              peerKey: dialog.key,
              peerId: dialog.peer.id,
              peerType: dialog.peer.type,
              title: dialog.title,
              username: dialog.username ?? cleanUsername,
              accessHash: dialog.peer.accessHash,
              accountId,
              state: this.newCredentialAutoRenew ? 'temp_auto_renew' : 'temp_ephemeral',
              autoRenew: this.newCredentialAutoRenew,
              lastVerifiedAt: Date.now(),
              peekExpiresAt: Date.now() + 48 * 3600_000,
              participantsCount: dialog.participantsCount,
              linkedTileIds: [],
              status: 'healthy',
            };
            this.upsertTempCredential(cred);
            if (this.newCredentialPlaceToBoard && targetGroup) {
              this.placeTempCredentialTile(cred, targetGroup.id);
            }
            addedCount += 1;
          }
        }
        this.newCredentialInput = '';
        await this.persistGovernanceToOpfs();
        this.patrolNotice = `已成功解析并入池 ${addedCount} 个免打扰临时会话凭据`;
      } catch (err) {
        this.patrolNotice = chatDataSource.readError(err);
      } finally {
        this.isAddingCredential = false;
      }
    },

    upsertTempCredential(cred: TempSessionCredential) {
      const idx = this.tempCredentials.findIndex((c) => c.id === cred.id);
      if (idx >= 0) this.tempCredentials[idx] = cred;
      else this.tempCredentials.unshift(cred);
    },

    placeTempCredentialTile(cred: TempSessionCredential, groupId: string) {
      const tileStore = useTileStore();
      const chatStore = useChatStore();
      const chatMediaStore = useChatMediaStore();
      const group = tileStore.groups.find((g) => g.id === groupId) ?? tileStore.groups[0];
      if (!group) return;
      const dialog = chatStore.dialogs[cred.peerKey as TgPeerKey];
      const liveAvatar = chatMediaStore.dialogAvatarUrl(cred.peerKey);
      const avatarThumb =
        dialog?.avatar?.thumb ?? (liveAvatar && !liveAvatar.startsWith('blob:') ? liveAvatar : undefined);
      const newTile = tileStore.addNewFile(
        {
          title: cred.title,
          size: 'medium',
          fileType: 'generic',
          extension: 'tg',
          description: cred.about || (cred.username ? `@${cred.username}` : '免打扰临时凭据会话'),
          sourceResultId: cred.peerKey,
          sessionId: cred.peerKey,
          sessionTitle: cred.title,
          isSessionLink: true,
          accountId: cred.accountId,
          peerKey: cred.peerKey,
          peerType: cred.peerType,
          accessHash: cred.accessHash,
          username: cred.username,
          inviteHash: cred.inviteHash,
          sessionCredentialState: cred.autoRenew ? 'temp_auto_renew' : 'temp_ephemeral',
          peekExpiresAt: cred.peekExpiresAt,
          lastVerifiedAt: cred.lastVerifiedAt,
          autoRenew: cred.autoRenew,
          participantsCount: cred.participantsCount,
          thumb: avatarThumb
            ? {
                status: 'pending',
                strippedDataUrl: avatarThumb,
                retryCount: 0,
              }
            : undefined,
        },
        group.id,
        this.targetFolderId || undefined,
      );
      if (newTile?.id) {
        tileStore.scheduleTileCoverRefresh([newTile.id], 'temp_credential_place');
      }
      if (!cred.linkedTileIds.includes(newTile.id)) {
        cred.linkedTileIds.push(newTile.id);
      }
    },

    async patrolAllTempCredentials() {
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      if (!accountId || this.tempCredentials.length === 0) return;

      this.isPatrollingPool = true;
      this.patrolNotice = null;
      const taskId = this.enqueueTask({
        kind: 'credential_patrol',
        title: `批量巡检 ${this.tempCredentials.length} 个临时会话凭据`,
        total: this.tempCredentials.length,
        accountId,
      });

      try {
        // 1. 收集具备 channel peerKey 的临时凭据，用 channels.GetChannels 批量巡检
        const channelPeers: TgPeerRef[] = [];
        for (const cred of this.tempCredentials) {
          if (cred.peerKey.startsWith('channel-') && cred.accessHash) {
            channelPeers.push({
              type: 'channel',
              id: cred.peerKey.replace(/^channel-/, ''),
              accessHash: cred.accessHash,
            });
          }
        }

        if (channelPeers.length > 0) {
          const batchRes = await chatDataSource.batchCheckChannels(accountId, channelPeers);
          const mapByKey = new Map(batchRes.dialogs.map((d) => [d.key as string, d]));
          for (const cred of this.tempCredentials) {
            const fresh = mapByKey.get(cred.peerKey);
            if (fresh) {
              cred.accessHash = fresh.peer.accessHash;
              cred.title = fresh.title;
              cred.participantsCount = fresh.participantsCount;
              cred.lastVerifiedAt = Date.now();
              cred.status = 'healthy';
            }
          }
        }

        // 2. 对开启 autoRenew 且包含 inviteHash 的凭据巡检刷新
        let done = 0;
        for (const cred of this.tempCredentials) {
          done += 1;
          this.updateTaskProgress(taskId, done);
          if (!cred.autoRenew) continue;
          if (cred.inviteHash) {
            try {
              const preview = await chatDataSource.checkChatInvite(accountId, cred.inviteHash);
              cred.title = preview.title;
              cred.participantsCount = preview.participantsCount;
              cred.accessHash = preview.dialog?.peer.accessHash ?? cred.accessHash;
              cred.lastVerifiedAt = Date.now();
              cred.status = 'healthy';
            } catch {
              cred.status = 'expired';
            }
          }
        }

        await this.persistGovernanceToOpfs();
        this.completeTask(taskId);
        this.patrolNotice = `已完成 ${this.tempCredentials.length} 个临时凭据的静默健康巡检`;
      } catch (err) {
        this.failTask(taskId, chatDataSource.readError(err));
        this.patrolNotice = chatDataSource.readError(err);
      } finally {
        this.isPatrollingPool = false;
      }
    },

    async upgradeTempCredentialToJoined(credId: string) {
      const cred = this.tempCredentials.find((c) => c.id === credId);
      if (!cred) return;
      const chatStore = useChatStore();
      const joined = await chatStore.batchJoinAndArchive(
        [
          {
            inviteHash: cred.inviteHash,
            username: cred.username,
            peer: cred.peerKey.startsWith('channel-') && cred.accessHash
              ? { type: 'channel', id: cred.peerKey.replace(/^channel-/, ''), accessHash: cred.accessHash }
              : undefined,
          },
        ],
        true,
      );
      if (joined.length > 0) {
        const dialog = joined[0]!;
        const tileStore = useTileStore();
        tileStore.upgradeSessionTileCredential(cred.peerKey, 'joined');
        if (dialog.key !== cred.peerKey) {
          tileStore.upgradeSessionTileCredential(dialog.key, 'joined');
        }
        this.tempCredentials = this.tempCredentials.filter((c) => c.id !== credId);
        await this.persistGovernanceToOpfs();
        this.patrolNotice = `「${cred.title}」已转正为正式加入并在 Telegram 归档`;
      }
    },

    async removeTempCredential(credId: string) {
      this.tempCredentials = this.tempCredentials.filter((c) => c.id !== credId);
      await this.persistGovernanceToOpfs();
    },

    // =========================================================================
    // Tab 3: 多账号凭据矩阵、无缝导入与配额引擎
    // =========================================================================
    async probeAllAccountsHealth() {
      const telegramStore = useTelegramStore();
      if (telegramStore.accounts.length === 0) return;
      this.isProbingHealth = true;
      try {
        for (const acc of telegramStore.accounts) {
          const existing = this.governanceRecords[acc.tg_user_id];
          try {
            const report = await chatDataSource.probeAccountHealth(acc.tg_user_id);
            const createdAtSec = report.currentSessionCreatedAt ?? Math.floor(Date.now() / 1000);
            const ageHours = Math.max(0, (Date.now() / 1000 - createdAtSec) / 3600);
            this.governanceRecords[acc.tg_user_id] = {
              accountId: acc.tg_user_id,
              phone: acc.phone_mask ?? undefined,
              username: acc.username ?? undefined,
              displayName: [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.tg_user_id,
              isPremium: Boolean(acc.is_premium),
              dcId: report.dcId || 2,
              tier: telegramStore.currentAccountId === acc.tg_user_id ? 'P0_foreground' : 'P1_warm_active',
              healthStatus: ageHours < 24 ? 'probation_24h' : 'healthy',
              joinedChannelsCount: existing?.joinedChannelsCount ?? 0,
              maxChannelsLimit: acc.is_premium ? 1000 : 500,
              accountTtlDays: report.accountTtlDays || 365,
              authorizationTtlDays: report.authorizationTtlDays || 365,
              deviceFingerprint: existing?.deviceFingerprint ?? {
                deviceModel: 'Desktop',
                systemVersion: 'Mac OS X 14.5',
                appVersion: '5.12.3',
                langCode: 'zh-hans',
                systemLangCode: 'zh-CN',
              },
              activeSessionsCount: report.activeSessionsCount || acc.authorizations.length,
              pendingSlots: existing?.pendingSlots ?? [],
              lastAuditAtMs: Date.now(),
              lastKeepaliveAtMs: Date.now(),
            };
          } catch {
            this.governanceRecords[acc.tg_user_id] = existing ?? {
              accountId: acc.tg_user_id,
              phone: acc.phone_mask ?? undefined,
              username: acc.username ?? undefined,
              displayName: [acc.first_name, acc.last_name].filter(Boolean).join(' ') || acc.tg_user_id,
              isPremium: Boolean(acc.is_premium),
              dcId: 2,
              tier: 'P2_cold_standby',
              healthStatus: 'offline',
              joinedChannelsCount: 0,
              maxChannelsLimit: acc.is_premium ? 1000 : 500,
              accountTtlDays: 365,
              authorizationTtlDays: 365,
              deviceFingerprint: {
                deviceModel: 'Desktop',
                systemVersion: 'Mac OS X 14.5',
                appVersion: '5.12.3',
                langCode: 'zh-hans',
                systemLangCode: 'zh-CN',
              },
              activeSessionsCount: acc.authorizations.length,
              pendingSlots: [],
            };
          }
        }
      } finally {
        this.isProbingHealth = false;
      }
    },

    async spawnAccountPendingSlot(accountId: string) {
      const telegramStore = useTelegramStore();
      if (!telegramStore.credentials) {
        this.batchImportNotice = '请先配置应用 API 凭据';
        return;
      }
      this.isSpawningSlot[accountId] = true;
      this.batchImportNotice = null;
      try {
        const res = await chatDataSource.spawnPendingSlot(
          accountId,
          telegramStore.credentials.apiId,
          telegramStore.credentials.apiHash,
          this.spawn2FAPasswordInput.trim() || undefined,
        );
        const slotId = `slot-${res.createdAtMs}`;
        const slotKey = `${accountId}:slot:${slotId}`;
        await tgSessionVault.save(slotKey, {
          dcId: res.dcId,
          stringSession: res.session,
          apiId: telegramStore.credentials.apiId,
          apiHash: telegramStore.credentials.apiHash,
        });
        const slotRecord: PendingSlotRecord = {
          slotId,
          accountId,
          sealedSession: slotKey,
          deviceFingerprint: {
            deviceModel: 'Lattice Standby Node',
            systemVersion: 'macOS 15.2',
            appVersion: '2.0.0',
            langCode: 'zh-hans',
            systemLangCode: 'zh-CN',
          },
          createdAtMs: res.createdAtMs,
          confirmedOfficial: res.confirmedOfficial,
          restrictionEndsAtMs: res.createdAtMs + 24 * 3600_000,
          lastKeepaliveAtMs: res.createdAtMs,
          status: 'in_24h_Restriction',
        };
        const gov = this.governanceRecords[accountId];
        if (gov) {
          gov.pendingSlots.push(slotRecord);
        }
        this.spawn2FAPasswordInput = '';
        this.batchImportNotice = `已通过 6 步同机回环成功裂变并封印热备槽位 ${slotId}`;
      } catch (err) {
        this.batchImportNotice = `生成热备槽位失败：${chatDataSource.readError(err)}`;
      } finally {
        this.isSpawningSlot[accountId] = false;
      }
    },

    async importBatchSessionsFromFiles(files: FileList | File[]) {
      const telegramStore = useTelegramStore();
      if (!telegramStore.credentials) {
        this.batchImportNotice = '请先在设置中保存 Telegram API 凭据';
        return;
      }
      this.isBatchImporting = true;
      this.batchImportNotice = null;
      try {
        const parsed = await sessionBatchImporter.parseFiles(files);
        if (parsed.length === 0) {
          this.batchImportNotice = '未能从所选文件中解析出有效的 256 字节 auth_key 会话';
          return;
        }
        let importedCount = 0;
        for (const item of parsed) {
          const tempAccountId = item.phone ?? `imported-${Date.now()}-${importedCount}`;
          await tgSessionVault.save(tempAccountId, {
            dcId: item.dcId,
            stringSession: item.sessionString,
            apiId: telegramStore.credentials.apiId,
            apiHash: telegramStore.credentials.apiHash,
          });
          void telegramStore.ensureBridge().restoreWarmAccount(
            telegramStore.credentials.apiId,
            telegramStore.credentials.apiHash,
            tempAccountId,
            item.sessionString,
          );
          importedCount += 1;
        }
        this.batchImportNotice = `已成功无头解析并导入 ${importedCount} 个外部会话进入热连接池`;
      } catch (err) {
        this.batchImportNotice = err instanceof Error ? err.message : '批量解析会话文件失败';
      } finally {
        this.isBatchImporting = false;
      }
    },

    async importBatchSessionsFromText() {
      const telegramStore = useTelegramStore();
      if (!telegramStore.credentials) {
        this.batchImportNotice = '请先在设置中保存 Telegram API 凭据';
        return;
      }
      const parsed = sessionBatchImporter.parseTextLines(this.batchImportTextInput);
      if (parsed.length === 0) {
        this.batchImportNotice = '请输入有效的 StringSession 字符串（每行一条）';
        return;
      }
      this.isBatchImporting = true;
      try {
        let importedCount = 0;
        for (const item of parsed) {
          const tempAccountId = item.phone ?? `str-${Date.now()}-${importedCount}`;
          await tgSessionVault.save(tempAccountId, {
            dcId: item.dcId,
            stringSession: item.sessionString,
            apiId: telegramStore.credentials.apiId,
            apiHash: telegramStore.credentials.apiHash,
          });
          void telegramStore.ensureBridge().restoreWarmAccount(
            telegramStore.credentials.apiId,
            telegramStore.credentials.apiHash,
            tempAccountId,
            item.sessionString,
          );
          importedCount += 1;
        }
        this.batchImportTextInput = '';
        this.batchImportNotice = `已成功导入 ${importedCount} 条 StringSession 进入热连接池`;
      } finally {
        this.isBatchImporting = false;
      }
    },

    setQuotaPreset(preset: 'conservative' | 'standard' | 'aggressive') {
      this.quotaPolicy.mode = preset;
      this.quotaPolicy.rules = buildDefaultRules(preset);
      void this.persistGovernanceToOpfs();
    },

    updateCustomQuotaLimit(rule: QuotaRuleKey, maxPerDay: number) {
      this.quotaPolicy.mode = 'custom';
      const item = this.quotaPolicy.rules[rule];
      if (item) {
        item.maxCount = Math.max(1, maxPerDay);
      }
      void this.persistGovernanceToOpfs();
    },

    consumeQuota(accountId: string, rule: QuotaRuleKey, count = 1): { allowed: boolean; reason?: string; waitMs?: number } {
      const now = Date.now();
      const floodUntil = this.floodWaitUntil[accountId] ?? 0;
      if (floodUntil > now) {
        const waitSec = Math.ceil((floodUntil - now) / 1000);
        return { allowed: false, reason: `账号处于 Telegram FLOOD_WAIT 退避保护中（剩余 ${waitSec}s）`, waitMs: floodUntil - now };
      }
      const limits = this.effectiveQuotaLimits[rule];
      const accUsage = (this.quotaUsageToday[accountId] ??= {
        joinChannel: 0,
        checkChatInvite: 0,
        resolveUsername: 0,
        botCallbackPage: 0,
        messagesSearch: 0,
      });
      if (accUsage[rule] + count > limits.maxPerDay) {
        return {
          allowed: false,
          reason: `今日配额已达上限 (${accUsage[rule]}/${limits.maxPerDay})，可在「账户与配额」中调整策略`,
        };
      }
      accUsage[rule] += count;
      const accTimestamps = (this.lastActionTimestamps[accountId] ??= {
        joinChannel: 0,
        checkChatInvite: 0,
        resolveUsername: 0,
        botCallbackPage: 0,
        messagesSearch: 0,
      });
      accTimestamps[rule] = now;
      return { allowed: true };
    },

    // =========================================================================
    // Tab 4: 共享私有备份群 & OPFS 5 子域存储治理
    // =========================================================================
    async bindAndInitVaultGroup(peerKey: string) {
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      const dialog = chatStore.dialogs[peerKey as TgPeerKey];
      if (!accountId || !dialog) {
        this.vaultNotice = '请先选择一个已加入的超级群组作为共享私有备份群';
        return;
      }
      this.isInitializingVault = true;
      this.vaultNotice = null;
      try {
        const info = await chatDataSource.ensureVaultForumTopics(accountId, dialog.peer);
        this.vaultConfig = {
          enabled: true,
          vaultPeerKey: info.vaultPeerKey,
          vaultTitle: info.vaultTitle,
          ownerAccountId: accountId,
          memberAccountIds: [accountId],
          topics: info.topics,
          lastBeaconSyncAtMs: Date.now(),
        };
        await this.persistGovernanceToOpfs();
        this.vaultNotice = `已成功绑定「${info.vaultTitle}」并确保 5 大标准 Forum 话题卷就绪`;
      } catch (err) {
        this.vaultNotice = `初始化备份群话题失败：${chatDataSource.readError(err)}`;
      } finally {
        this.isInitializingVault = false;
      }
    },

    async syncTempPoolToVaultBeacon() {
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      if (!accountId || !this.vaultConfig) {
        this.vaultNotice = '请先绑定共享私有备份群';
        return;
      }
      const dialog = chatStore.dialogs[this.vaultConfig.vaultPeerKey as TgPeerKey];
      const vaultPeer: TgPeerRef = dialog?.peer ?? {
        type: 'channel',
        id: this.vaultConfig.vaultPeerKey.replace(/^channel-/, ''),
      };
      this.isSyncingBeacon = true;
      this.vaultNotice = null;
      try {
        const payload = JSON.stringify({
          updatedAt: Date.now(),
          credentials: this.tempCredentials,
        });
        const res = await chatDataSource.syncBeaconCredentials(
          accountId,
          vaultPeer,
          this.vaultConfig.topics.beacon,
          payload,
        );
        this.vaultConfig.lastBeaconSyncAtMs = Date.now();
        await this.persistGovernanceToOpfs();
        this.vaultNotice = `已从信标卷同步 ${res.syncedDialogs.length} 个跨设备新鲜凭据`;
      } catch (err) {
        this.vaultNotice = `信标同步失败：${chatDataSource.readError(err)}`;
      } finally {
        this.isSyncingBeacon = false;
      }
    },

    async backupTileMediaToVault(tileId: string) {
      const tileStore = useTileStore();
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      if (!accountId || !this.vaultConfig) {
        this.vaultNotice = '请先在「会话与配额管理器 -> 备份群与存储」中绑定共享私有备份群';
        return;
      }
      const tile = tileStore.getTileById(tileId);
      if (!tile || tile.type !== 'file') return;
      const src = tile.sources?.[0];
      if (!src) return;

      const vaultDialog = chatStore.dialogs[this.vaultConfig.vaultPeerKey as TgPeerKey];
      const vaultPeer: TgPeerRef = vaultDialog?.peer ?? {
        type: 'channel',
        id: this.vaultConfig.vaultPeerKey.replace(/^channel-/, ''),
      };
      const fromDialog = chatStore.dialogs[src.peerKey as TgPeerKey];
      const fromPeer: TgPeerRef = fromDialog?.peer ?? {
        type: src.peerType,
        id: src.peerId,
        accessHash: src.accessHash,
      };

      const taskId = this.enqueueTask({
        kind: 'vault_clone',
        title: `${tile.noforwards ? '流式克隆受限媒体' : '零带宽秒传备份'}「${tile.title}」`,
        total: 1,
        accountId,
      });

      const topicId =
        tile.fileType === 'video'
          ? this.vaultConfig.topics.video
          : tile.fileType === 'image'
            ? this.vaultConfig.topics.photo
            : this.vaultConfig.topics.document;

      try {
        if (tile.noforwards) {
          const res = await chatDataSource.cloneNoForwardsToVault(
            accountId,
            fromPeer,
            vaultPeer,
            src.msgId,
            topicId,
          );
          tile.hasVaultCopy = true;
          if (res.message) {
            tile.vaultRef = {
              vaultPeerKey: this.vaultConfig.vaultPeerKey,
              topicId,
              msgId: res.message.id,
            };
          }
        } else {
          const res = await chatDataSource.forwardToVault(
            accountId,
            fromPeer,
            vaultPeer,
            [src.msgId],
            topicId,
            false,
          );
          tile.hasVaultCopy = true;
          tile.vaultRef = {
            vaultPeerKey: this.vaultConfig.vaultPeerKey,
            topicId,
            msgId: res.forwardedMsgIds[0] ?? src.msgId,
          };
        }
        tileStore.saveState();
        this.completeTask(taskId);
      } catch (err) {
        this.failTask(taskId, chatDataSource.readError(err));
      }
    },

    async refreshStorageQuotaDashboard() {
      this.isPersistedStorage = await storageQuotaEvictor.ensurePersistentStoragePermission();
      this.storageSubDomains = storageQuotaEvictor.computeSubDomainQuotas();
      this.totalStorageUsedBytes = this.storageSubDomains.reduce((acc, s) => acc + s.usedBytes, 0);
    },

    async evictSubDomainNow(subDomainId: StorageSubDomainId) {
      if (subDomainId === 'core-metadata') return;
      this.isCleaningStorage = true;
      try {
        await storageQuotaEvictor.clearSubDomainCache(subDomainId);
        await this.refreshStorageQuotaDashboard();
      } finally {
        this.isCleaningStorage = false;
      }
    },

    async runFullOrphanGcNow() {
      const tileStore = useTileStore();
      this.isCleaningStorage = true;
      try {
        const activeIds = new Set<string>();
        const walk = (list: typeof tileStore.tiles) => {
          for (const t of list) {
            activeIds.add(t.id);
            if (t.type === 'folder') walk(t.children);
          }
        };
        walk(tileStore.tiles);
        await storageQuotaEvictor.runMaintenanceAndEviction(activeIds);
        await this.refreshStorageQuotaDashboard();
      } finally {
        this.isCleaningStorage = false;
      }
    },

    async downloadColdBackupNow() {
      const tileStore = useTileStore();
      await tileStore.exportColdArchive();
    },

    // =========================================================================
    // 后台任务与配额 HUD
    // =========================================================================
    toggleHudExpanded() {
      this.isHudExpanded = !this.isHudExpanded;
    },

    enqueueTask(params: { kind: BackgroundTaskItem['kind']; title: string; total: number; accountId?: string }): string {
      const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      this.tasks.unshift({
        id,
        kind: params.kind,
        title: params.title,
        subtitle: params.kind,
        status: 'running',
        progressCurrent: 0,
        progressTotal: Math.max(1, params.total),
        accountId: params.accountId,
        createdAtMs: Date.now(),
      });
      return id;
    },

    updateTaskProgress(taskId: string, current: number, total?: number) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      task.progressCurrent = current;
      if (total !== undefined) task.progressTotal = total;
    },

    completeTask(taskId: string) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      task.status = 'completed';
      task.progressCurrent = task.progressTotal;
    },

    failTask(taskId: string, errorMessage: string) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      task.status = 'failed';
      task.errorMessage = errorMessage;
    },

    cancelTask(taskId: string) {
      const task = this.tasks.find((t) => t.id === taskId);
      if (!task) return;
      task.status = 'paused';
    },

    clearCompletedTasks() {
      this.tasks = this.tasks.filter((t) => t.status === 'running' || t.status === 'paused');
    },

    // =========================================================================
    // Phase 5: 单行 Gzip 云同步与客户端 CRDT 三路合并
    // =========================================================================
    setSyncIntervalMode(mode: SyncIntervalMode) {
      this.cloudSync.syncInterval = mode;
    },

    async syncExploreToCloudNow() {
      if (this.cloudSync.status === 'syncing') return;
      this.cloudSync.status = 'syncing';
      this.cloudSync.errorMessage = null;
      const tileStore = useTileStore();

      try {
        tileStore.tempCredentials = this.tempCredentials;
        if (this.vaultConfig) tileStore.vaultConfig = this.vaultConfig;
        const localManifest = tileStore.buildExploreManifest();
        localManifest.quotaPolicy = this.quotaPolicy;

        const result = await exploreSyncEngine.syncNow(localManifest, this.cloudSync.lastSyncedRevision);
        tileStore.applyExploreManifest(result.mergedManifest, true);
        if (result.mergedManifest.tempCredentials) {
          this.tempCredentials = result.mergedManifest.tempCredentials;
        }
        if (result.mergedManifest.quotaPolicy) {
          this.quotaPolicy = result.mergedManifest.quotaPolicy;
        }
        if (result.mergedManifest.vaultConfig) {
          this.vaultConfig = result.mergedManifest.vaultConfig;
        }
        await opfsExploreStorage.writeManifest(result.mergedManifest);
        this.cloudSync.lastSyncedRevision = result.revision;
        this.cloudSync.lastSyncedAtMs = result.updatedAt;
        writePersistedSyncMeta(result.revision, result.updatedAt);
        this.cloudSync.status = 'synced';
        window.setTimeout(() => {
          if (this.cloudSync.status === 'synced') {
            this.cloudSync.status = 'idle';
          }
        }, 2200);
      } catch (err) {
        this.cloudSync.status = 'error';
        this.cloudSync.errorMessage = err instanceof Error ? err.message : '云端同步失败';
        window.setTimeout(() => {
          if (this.cloudSync.status === 'error') {
            this.cloudSync.status = 'idle';
          }
        }, 3500);
      }
    },
  },
});
