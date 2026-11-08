/**
 * [STORE] 搜索机器人 [startPage, endPage] 自动翻页收割机 Store (BotHarvesterStore)
 *
 * 职责（纯视图状态与动作编排）：
 * 1. 管理翻页区间、当前收割任务进度、候选链接池与批量收藏弹窗状态；
 * 2. 双向绑定「我方发出的查询消息 (Outbox Query) ↔ 机器人回复的分页消息 (Inbox Reply)」；
 * 3. 基于 UpdateEditMessage 实时事件驱动自动翻页（不阻塞等待 10s BOT_RESPONSE_TIMEOUT）；
 * 4. 严守敏感 API 零重复申领原则：解析即入驻会话管理中心临时凭据池（默认不自动续签），收藏至磁贴纯本地执行。
 */
import { defineStore } from 'pinia';
import type { AggregateSearchResultItem, BotHarvestTaskState } from '@/stores/archive/types';
import type { BotHarvestCandidateItem } from '@/types/botHarvest';
import { useAggregateSearchStore } from '@/stores/archive/stores/aggregateSearchStore';
import { useSessionManagerStore } from '@/stores/archive/stores/sessionManagerStore';
import { useTileStore } from '@/stores/archive/stores/tileStore';
import type { SessionCredentialState } from '@/views/main/archive/types/tile';
import { useChatStore } from './chatStore';
import { telegramBusClient } from '@/stores/telegram/data-sources/telegramBusClient';
import type { TgChatKind, TgDialogDto, TgInlineButton, TgMessageDto } from '@/worker/local/chatProtocol';
import { debugLoggerDataSource } from '@/stores/app/data-sources/debugLoggerDataSource';

const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });
const isHarvestableChatKind = (kind: TgChatKind): kind is 'group' | 'supergroup' | 'channel' =>
  kind === 'group' || kind === 'supergroup' || kind === 'channel';
/** 同一消息元数据只保留一个在途 Worker 解析；过期响应不得覆盖新版本。 */
const pendingBotMetadata = new Map<string, string>();

export const useBotHarvesterStore = defineStore('botHarvester', {
  state: () => ({
    startPageByMsg: {} as Record<number, number>,
    parsedPageByMsg: {} as Record<number, number>,
    pairedQueryByMsg: {} as Record<number, { queryText: string; queryMsgId?: number }>,
    metadataSignatureByMsg: {} as Record<number, string>,
    paginationByMsg: {} as Record<number, boolean>,
    endPageByMsg: {} as Record<number, number>,
    activeTask: null as (BotHarvestTaskState & {
      harvestedCount?: number;
      errorMessage?: string;
      pairedQueryText?: string;
      pairedQueryMsgId?: number;
    }) | null,
    candidates: [] as BotHarvestCandidateItem[],
    candidateFilterKeyword: '',
    lastClickedCandidateIndex: null as number | null,
    isCandidateModalOpen: false,
    isLeftTreeOpen: true,
    /** 「解析消息」设置弹窗当前对应的消息 ID；null 表示弹窗关闭。 */
    dialogMessageId: null as number | null,
    targetExploreGroupId: 'group-default',
    targetExploreFolderId: '',
    /** 默认凭据状态为单次快照（不自动续签），收藏时仅更新本地凭据标记，不重复请求敏感 API。 */
    placementMode: 'temp_ephemeral' as SessionCredentialState,
    archiveOnJoin: true,
    isCommitting: false,
    harvestNotice: null as string | null,
    metadataFailedByMsg: {} as Record<number, boolean>,
  }),

  getters: {
    filteredCandidates(state): BotHarvestCandidateItem[] {
      const kw = state.candidateFilterKeyword.trim().toLowerCase();
      if (!kw) return state.candidates;
      return state.candidates.filter(
        (c) =>
          c.title.toLowerCase().includes(kw) ||
          (c.username?.toLowerCase().includes(kw) ?? false) ||
          c.sourceTextSnippet.toLowerCase().includes(kw),
      );
    },

    selectedCandidates(state): BotHarvestCandidateItem[] {
      return state.candidates.filter((c) => c.selected);
    },
  },

  actions: {
    getStartPage(messageId: number): number {
      if (this.startPageByMsg[messageId] !== undefined) {
        return this.startPageByMsg[messageId]!;
      }
      return this.parsedPageByMsg[messageId] ?? 1;
    },

    setStartPage(messageId: number, page: number) {
      const clamped = Math.max(1, Math.min(50, Math.floor(page) || 1));
      this.startPageByMsg[messageId] = clamped;
      if ((this.endPageByMsg[messageId] ?? 5) < clamped) {
        this.endPageByMsg[messageId] = clamped;
      }
    },

    getEndPage(messageId: number): number {
      const start = this.getStartPage(messageId);
      const configured = this.endPageByMsg[messageId] ?? Math.max(5, start + 4);
      return Math.max(start, configured);
    },

    setEndPage(messageId: number, page: number) {
      const start = this.getStartPage(messageId);
      const clamped = Math.max(start, Math.min(50, Math.floor(page) || start));
      this.endPageByMsg[messageId] = clamped;
    },

    /** 获取 Worker 解析并缓存的查询词。 */
    getPairedQuery(messageId: number): { queryText: string; queryMsgId?: number } {
      return this.pairedQueryByMsg[messageId] ?? { queryText: '当前页检索' };
    },

    hasPaginationControls(_rows: TgInlineButton[][], messageId?: number): boolean {
      return messageId ? Boolean(this.paginationByMsg[messageId]) : false;
    },

    async refreshMessageMetadata(accountId: string, message: TgMessageDto, windowMessages: TgMessageDto[] = [], fallbackLastQuery?: string) {
      const signature = JSON.stringify([accountId, message.id, message.text, message.replyMarkup, message.replyToId, windowMessages.map((item) => [item.id, item.text, item.out, item.replyToId]), fallbackLastQuery ?? '']);
      const key = String(message.id);
      if (this.metadataSignatureByMsg[message.id] === signature || pendingBotMetadata.get(key) === signature) return;
      pendingBotMetadata.set(key, signature);
      try {
        const metadata = await telegramBusClient.bot.metadata(accountId, message, windowMessages, fallbackLastQuery);
        if (pendingBotMetadata.get(key) !== signature) return;
        this.metadataSignatureByMsg[message.id] = signature;
        if (metadata.page && metadata.page > 0) this.parsedPageByMsg[message.id] = metadata.page;
        this.paginationByMsg[message.id] = metadata.hasPagination;
        this.pairedQueryByMsg[message.id] = metadata.pairedQuery;
      } finally {
        if (pendingBotMetadata.get(key) === signature) pendingBotMetadata.delete(key);
      }
    },

    mergeCandidates(items: BotHarvestCandidateItem[]) {
      const existingByKey = new Map(this.candidates.map((candidate) => [candidate.key, candidate]));
      for (const item of items) {
        const existing = existingByKey.get(item.key);
        if (existing) {
          existing.username ??= item.username;
          existing.inviteHash ??= item.inviteHash;
          existing.accessHash ??= item.accessHash;
          existing.avatarPhotoId ??= item.avatarPhotoId;
          existing.avatarDcId ??= item.avatarDcId;
          existing.avatarThumb ??= item.avatarThumb;
          existing.participantsCount ??= item.participantsCount;
          existing.about ??= item.about;
          existing.peekExpiresAt ??= item.peekExpiresAt;
          existing.alreadyJoined = Boolean(existing.alreadyJoined || item.alreadyJoined);
        } else {
          this.candidates.push(item);
          existingByKey.set(item.key, item);
        }
      }
    },

    /**
     * 解析阶段：
     * 1. 优先复用本地已加入会话 (chatStore.dialogs) 或会话管理中心已有临时凭据 (sessionStore.tempCredentials)，零敏感 API 消耗；
     * 2. 仅对未知目标发起一次 ResolveUsername / CheckChatInvite，且过滤掉私聊/机器人/未知邀请；
     * 3. 解析成功后立即将凭据写入会话管理中心（默认 autoRenew: false，即不自动续签状态）。
     */
    async resolveHarvestCandidates(accountId: string, items: BotHarvestCandidateItem[]) {
      const chatStore = useChatStore();
      const sessionStore = useSessionManagerStore();
      const resolved: BotHarvestCandidateItem[] = [];
      const blockedQuotaRules = new Set<'resolveUsername' | 'checkChatInvite'>();
      let skipped = 0;
      let newlyAddedToPool = 0;
      let quotaReason: string | undefined;

      for (const item of items) {
        let dialog: TgDialogDto | undefined;
        let peekExpiresAt: number | undefined;
        let about: string | undefined;
        let participantsCount: number | undefined;
        let alreadyJoined: boolean | undefined;

        // 1. 先检查会话管理中心凭据池是否已有该目标的完整凭据（避免重复调用敏感 API）
        const cachedCred = sessionStore.tempCredentials.find((cred) => {
          if (item.internalChannelId && cred.peerType === 'channel' && cred.peerId === item.internalChannelId) {
            return true;
          }
          if (item.username && cred.username?.toLowerCase() === item.username.toLowerCase()) {
            return true;
          }
          if (item.inviteHash && cred.inviteHash === item.inviteHash) {
            return true;
          }
          return false;
        });

        if (cachedCred && (cachedCred.peerType === 'chat' || cachedCred.peerType === 'channel')) {
          const dialogInStore = chatStore.dialogs[cachedCred.peerKey as keyof typeof chatStore.dialogs];
          const peerKind: 'group' | 'supergroup' | 'channel' =
            cachedCred.peerKind ??
            (dialogInStore && isHarvestableChatKind(dialogInStore.kind)
              ? dialogInStore.kind
              : cachedCred.peerType === 'chat'
                ? 'group'
                : 'channel');
          resolved.push({
            ...item,
            key: cachedCred.peerKey,
            title: dialogInStore?.title ?? cachedCred.title,
            username: cachedCred.username ?? item.username,
            inviteHash: cachedCred.inviteHash ?? item.inviteHash,
            peerKey: cachedCred.peerKey,
            peerId: cachedCred.peerId,
            peerType: cachedCred.peerType,
            peerKind,
            accessHash: dialogInStore?.peer.accessHash ?? cachedCred.accessHash,
            avatarPhotoId: dialogInStore?.avatar?.photoId ?? cachedCred.avatarPhotoId,
            avatarDcId: dialogInStore?.avatar?.dcId ?? cachedCred.avatarDcId,
            avatarThumb: dialogInStore?.avatar?.thumb ?? cachedCred.avatarThumb,
            participantsCount: dialogInStore?.participantsCount ?? cachedCred.participantsCount,
            about: cachedCred.about,
            peekExpiresAt: cachedCred.peekExpiresAt,
            alreadyJoined: Boolean(dialogInStore && !dialogInStore.left),
          });
          continue;
        }

        // 2. 再检查本地已加载会话列表，未命中时才发起一次敏感 API 请求
        if (item.internalChannelId) {
          dialog = Object.values(chatStore.dialogs).find(
            (candidate) => candidate.peer.type === 'channel' && candidate.peer.id === item.internalChannelId,
          );
        } else if (item.username) {
          dialog = Object.values(chatStore.dialogs).find(
            (candidate) => candidate.username?.toLowerCase() === item.username!.toLowerCase(),
          );
          if (!dialog) {
            if (blockedQuotaRules.has('resolveUsername')) {
              skipped += 1;
              continue;
            }
            const quota = sessionStore.consumeQuota(accountId, 'resolveUsername', 1);
            if (!quota.allowed) {
              blockedQuotaRules.add('resolveUsername');
              quotaReason ??= quota.reason;
              skipped += 1;
              continue;
            }
            try {
              dialog = (await telegramBusClient.chatCommand.resolveUsername(accountId, item.username)) ?? undefined;
            } catch {
              skipped += 1;
              continue;
            }
          }
        } else if (item.inviteHash) {
          if (blockedQuotaRules.has('checkChatInvite')) {
            skipped += 1;
            continue;
          }
          const quota = sessionStore.consumeQuota(accountId, 'checkChatInvite', 1);
          if (!quota.allowed) {
            blockedQuotaRules.add('checkChatInvite');
            quotaReason ??= quota.reason;
            skipped += 1;
            continue;
          }
          try {
            const preview = await telegramBusClient.chatCommand.checkChatInvite(accountId, item.inviteHash);
            dialog = preview.dialog ?? undefined;
            peekExpiresAt = preview.peekExpiresAt;
            about = preview.about;
            participantsCount = preview.participantsCount;
            alreadyJoined = preview.status === 'already';
          } catch {
            skipped += 1;
            continue;
          }
        }

        if (!dialog || !isHarvestableChatKind(dialog.kind) || (dialog.peer.type !== 'chat' && dialog.peer.type !== 'channel')) {
          skipped += 1;
          continue;
        }

        const isJoined = alreadyJoined ?? Boolean(chatStore.dialogs[dialog.key] && !chatStore.dialogs[dialog.key]?.left);
        const enriched: BotHarvestCandidateItem = {
          ...item,
          key: dialog.key,
          title: dialog.title,
          username: dialog.username ?? item.username,
          peerKey: dialog.key,
          peerId: dialog.peer.id,
          peerType: dialog.peer.type,
          peerKind: dialog.kind,
          accessHash: dialog.peer.accessHash,
          avatarPhotoId: dialog.avatar?.photoId,
          avatarDcId: dialog.avatar?.dcId,
          avatarThumb: dialog.avatar?.thumb,
          participantsCount: participantsCount ?? dialog.participantsCount,
          about,
          peekExpiresAt,
          alreadyJoined: isJoined,
        };
        resolved.push(enriched);

        // 3. 解析成功即刻进入会话管理中心凭据池（默认不自动续签 autoRenew: false）
        if (!isJoined) {
          const existingPoolCred = sessionStore.tempCredentials.find((c) => c.peerKey === dialog.key);
          const preserveAutoRenew = existingPoolCred?.autoRenew ?? false;
          sessionStore.upsertTempCredential({
            id: existingPoolCred?.id ?? `temp-harvest-${dialog.key}`,
            peerKey: dialog.key,
            peerId: dialog.peer.id,
            peerType: dialog.peer.type,
            peerKind: dialog.kind,
            accessHash: dialog.peer.accessHash,
            avatarPhotoId: dialog.avatar?.photoId,
            avatarDcId: dialog.avatar?.dcId,
            avatarThumb: dialog.avatar?.thumb,
            title: dialog.title,
            username: dialog.username ?? item.username,
            inviteHash: item.inviteHash,
            accountId,
            state: preserveAutoRenew ? 'temp_auto_renew' : 'temp_ephemeral',
            autoRenew: preserveAutoRenew,
            lastVerifiedAt: Date.now(),
            peekExpiresAt: peekExpiresAt ?? Date.now() + 48 * 3600_000,
            participantsCount: participantsCount ?? dialog.participantsCount,
            about,
            linkedTileIds: existingPoolCred?.linkedTileIds ?? [],
            status: 'healthy',
          });
          newlyAddedToPool += 1;
        }
      }

      if (newlyAddedToPool > 0) {
        await sessionStore.persistGovernanceToOpfs();
      }

      return { items: resolved, skipped, quotaReason };
    },

    /**
     * 消息右侧工具条的「解析」入口：任何消息都可打开设置弹窗。
     * 分页元数据只在打开时向 Worker 请求一次（不再为每条机器人消息预取）；失败时弹窗仍可用，按单页解析。
     */
    async openHarvestDialog(messageId: number) {
      this.dialogMessageId = messageId;
      this.metadataFailedByMsg[messageId] = false;
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      const windowMessages = chatStore.activeWindow?.messages ?? [];
      const message = windowMessages.find((item) => item.id === messageId);
      if (!accountId || !message) return;
      try {
        await this.refreshMessageMetadata(
          accountId,
          message,
          windowMessages,
          chatStore.activeChatKey ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey] : undefined,
        );
      } catch (err) {
        this.metadataFailedByMsg[messageId] = true;
        debugLoggerDataSource.emitFrontendLog({
          domain: 'bot.callback',
          action: 'harvest_metadata_failed',
          level: 'WARN',
          message: err instanceof Error ? err.name : 'UnknownError',
          tags: { messageId },
        });
        // 失败与「确实没有翻页按钮」分开呈现；仍允许单页解析。
      }
    },

    closeHarvestDialog() {
      this.dialogMessageId = null;
    },

    /** 启动 [startPage, endPage] 事件驱动自动翻页收割任务 */
    async startHarvestRange(messageId: number) {
      const chatStore = useChatStore();
      const sessionStore = useSessionManagerStore();
      const accountId = chatStore.accountId;
      const dialog = chatStore.activeDialog;
      if (!accountId || !dialog) return;

      const startPage = this.getStartPage(messageId);
      const endPage = this.getEndPage(messageId);
      const initialMsg = chatStore.activeWindow?.messages.find((m) => m.id === messageId);
      let currentMessage = initialMsg;
      const paired = initialMsg
        ? (await telegramBusClient.bot.metadata(accountId, initialMsg, chatStore.activeWindow?.messages ?? [], chatStore.activeChatKey ? chatStore.lastSentQueryByPeer[chatStore.activeChatKey] : undefined)).pairedQuery
        : this.getPairedQuery(messageId);
      this.harvestNotice = null;

      const taskId = sessionStore.enqueueTask({
        kind: 'bot_harvest',
        title: `解析「${paired.queryText}」(${dialog.title} 第 ${startPage}~${endPage} 页)`,
        total: Math.max(1, endPage - startPage + 1),
        accountId,
      });

      const initialPage = initialMsg ? ((await telegramBusClient.bot.metadata(accountId, initialMsg, chatStore.activeWindow?.messages ?? [])).page ?? startPage) : startPage;
      const loopStart = Math.min(startPage, initialPage);

      this.activeTask = {
        taskId,
        peerKey: dialog.key,
        messageId,
        botName: dialog.title,
        startPage,
        endPage,
        currentPage: loopStart,
        status: 'running',
        candidates: [],
        targetGroupId: this.targetExploreGroupId,
        targetFolderId: this.targetExploreFolderId || null,
        autoJoinAndArchive: false,
        startedAtMs: Date.now(),
        harvestedCount: 0,
        pairedQueryText: paired.queryText,
        pairedQueryMsgId: paired.queryMsgId,
      };

      let resolvedLinkCount = 0;
      let skippedLinkCount = 0;
      let quotaReason: string | undefined;
      try {
        for (let page = loopStart; page <= endPage; page++) {
          if (!this.activeTask || this.activeTask.status !== 'running') break;
          this.activeTask.currentPage = page;

          if (currentMessage && page >= startPage) {
            const pageItems = await telegramBusClient.bot.extractCandidates(accountId, currentMessage, page);
            const verification = await this.resolveHarvestCandidates(accountId, pageItems);
            this.mergeCandidates(verification.items);
            resolvedLinkCount += verification.items.length;
            skippedLinkCount += verification.skipped;
            quotaReason ??= verification.quotaReason;
            this.activeTask.harvestedCount = this.candidates.length;
            sessionStore.updateTaskProgress(taskId, Math.max(1, page - startPage + 1));
          }

          if (page >= endPage) break;

          const nextBtn = currentMessage?.replyMarkup
            ? await telegramBusClient.bot.findNextButton(accountId, currentMessage.replyMarkup, page + 1)
            : null;
          if (!nextBtn || !nextBtn.data) break;

          const quotaCheck = sessionStore.consumeQuota(accountId, 'botCallbackPage', 1);
          if (!quotaCheck.allowed) {
            this.activeTask.status = 'paused_captcha';
            this.activeTask.pauseReason = quotaCheck.reason;
            this.activeTask.errorMessage = quotaCheck.reason;
            break;
          }

          // 1. 先注册 UpdateEditMessage 实时事件监听器（机器人编辑消息即在 200~500ms 内触发）
          const editWaiter = telegramBusClient.bot.waitForMessageEdit(dialog.key, messageId, 4800);

          // 2. 异步触发 GetBotCallbackAnswer（不阻塞等待 10s BOT_RESPONSE_TIMEOUT，且吞掉非致命超时）
          void telegramBusClient.bot
            .pressBotCallback(accountId, dialog.peer, messageId, nextBtn.data)
            .catch(() => undefined);

          // 3. 等待实时 UpdateEditMessage 到达；若 4.8s 超时未收到推送，再通过 getHistoryAround 兜底校准
          const editedMsg = await editWaiter;
          // 必须先切换到事件携带的最新 DTO，下一轮提取和按钮查找不得再读旧窗口快照。
          if (editedMsg) {
            currentMessage = editedMsg;
            if (chatStore.activeWindow) {
              const idx = chatStore.activeWindow.messages.findIndex((m) => m.id === messageId);
              if (idx >= 0) chatStore.activeWindow.messages[idx] = editedMsg;
            }
          }
          if (!this.activeTask || this.activeTask.status !== 'running') break;

          if (!editedMsg) {
            try {
              const refreshed = await telegramBusClient.chatRead.getHistoryAround(accountId, dialog.peer, messageId, 3);
              const updatedMsg = refreshed.messages.find((m) => m.id === messageId);
              if (updatedMsg) {
                currentMessage = updatedMsg;
                if (chatStore.activeWindow) {
                  const idx = chatStore.activeWindow.messages.findIndex((m) => m.id === messageId);
                  if (idx >= 0) chatStore.activeWindow.messages[idx] = updatedMsg;
                }
              }
            } catch {
              // 忽略历史校准异常，继续使用当前消息 DTO
            }
          }

          // 4. 拟人化微抖动间隔（900ms ~ 1400ms），兼顾连续翻页速度与防封控安全
          await wait(900 + Math.floor(Math.random() * 500));
        }

        if (this.activeTask && this.activeTask.status === 'running') {
          this.activeTask.status = 'completed';
          sessionStore.completeTask(taskId);
          const summary = `本次确认 ${resolvedLinkCount} 条链接，累计 ${this.candidates.length} 个去重群组 / 频道已存入会话管理中心凭据池（默认不自动续签）`;
          const skipped = skippedLinkCount > 0 ? `；跳过 ${skippedLinkCount} 条无法确认目标或非群组 / 频道的链接` : '';
          const quota = quotaReason ? `。${quotaReason}` : '';
          this.harvestNotice = `${summary}${skipped}${quota}`;
          this.dialogMessageId = null;
          this.openCandidateModal();
        }
      } catch (err) {
        const msg = telegramBusClient.readError(err);
        if (this.activeTask) {
          this.activeTask.status = 'error';
          this.activeTask.pauseReason = msg;
          this.activeTask.errorMessage = msg;
        }
        sessionStore.failTask(taskId, msg);
      }
    },

    stopHarvest() {
      if (this.activeTask) {
        this.activeTask.status = 'cancelled';
        this.activeTask = null;
      }
    },

    openCandidateModal() {
      const tileStore = useTileStore();
      const searchStore = useAggregateSearchStore();
      if (searchStore.expandedGroupIds.length === 0) {
        searchStore.expandAllTreeNodes();
      }
      if (tileStore.groups.length > 0 && !tileStore.groups.some((g) => g.id === this.targetExploreGroupId)) {
        this.targetExploreGroupId = tileStore.groups[0]!.id;
      }
      if (this.targetExploreFolderId) {
        const folder = tileStore.getTileById(this.targetExploreFolderId);
        if (!folder || folder.type !== 'folder') {
          this.targetExploreFolderId = '';
        }
      }
      this.isCandidateModalOpen = true;
    },

    closeCandidateModal() {
      const searchStore = useAggregateSearchStore();
      searchStore.cancelDragToTree();
      searchStore.closeTreeContextMenu();
      searchStore.cancelTreeInlineRename();
      this.isCandidateModalOpen = false;
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
        this.targetExploreGroupId = payload.groupId;
        this.targetExploreFolderId = payload.id;
      } else {
        this.targetExploreGroupId = payload.id;
        this.targetExploreFolderId = '';
      }
    },

    toggleCandidate(key: string) {
      const item = this.candidates.find((c) => c.key === key);
      if (item) item.selected = !item.selected;
    },

    handleCandidateCardClick(index: number, key: string, event: MouseEvent) {
      const list = this.filteredCandidates;
      if (event.shiftKey && this.lastClickedCandidateIndex !== null && list.length > 0) {
        const start = Math.max(0, Math.min(this.lastClickedCandidateIndex, index));
        const end = Math.min(list.length - 1, Math.max(this.lastClickedCandidateIndex, index));
        for (let i = start; i <= end; i++) {
          const target = list[i];
          if (target) target.selected = true;
        }
        return;
      }
      this.toggleCandidate(key);
      this.lastClickedCandidateIndex = index;
    },

    selectAllFiltered() {
      for (const item of this.filteredCandidates) item.selected = true;
    },

    clearSelection() {
      for (const item of this.candidates) item.selected = false;
      this.lastClickedCandidateIndex = null;
    },

    clearPool() {
      this.candidates = [];
      this.lastClickedCandidateIndex = null;
      this.harvestNotice = null;
    },

    /**
     * 将候选会话卡片直接拖拽至左栏 Explore 目录树进行本地收藏（零敏感 API 调用）
     */
    startDragCandidatesToTree(originItem: BotHarvestCandidateItem, clientX: number, clientY: number) {
      if (!originItem.selected) {
        originItem.selected = true;
      }
      if (!this.isLeftTreeOpen) {
        this.isLeftTreeOpen = true;
      }
      const chatStore = useChatStore();
      const searchStore = useAggregateSearchStore();
      const accountId = chatStore.accountId ?? undefined;

      const candidatesToDrag = this.filteredCandidates.filter((c) => c.selected);
      if (candidatesToDrag.length === 0) {
        candidatesToDrag.push(originItem);
      }

      const items: AggregateSearchResultItem[] = candidatesToDrag
        .filter((c) => Boolean(c.peerKey && c.peerId && c.peerType))
        .map((c) => {
          const kindLabel =
            c.peerKind === 'channel'
              ? '频道'
              : c.peerKind === 'supergroup'
                ? '超级群'
                : '群组';
          const credState: SessionCredentialState = c.alreadyJoined
            ? 'joined'
            : this.placementMode === 'temp_auto_renew'
              ? 'temp_auto_renew'
              : 'temp_ephemeral';
          return {
            id: c.peerKey!,
            title: c.title,
            snippet: c.about || (c.username ? `@${c.username}` : c.sourceTextSnippet),
            category: 'session',
            categoryLabel: kindLabel,
            fileType: 'generic',
            extension: 'TG',
            fileSize: c.participantsCount ? `${c.participantsCount} 成员` : kindLabel,
            participantsCount: c.participantsCount,
            sessionId: c.peerKey!,
            sessionTitle: c.title,
            sessionKind: c.alreadyJoined ? 'joined' : 'credential_only',
            credentialState: credState,
            username: c.username,
            inviteHash: c.inviteHash,
            avatarPhotoId: c.avatarPhotoId,
            avatarDcId: c.avatarDcId,
            peekExpiresAt: c.peekExpiresAt,
            lastVerifiedAt: Date.now(),
            autoRenew: credState === 'temp_auto_renew',
            updatedAt: new Date().toISOString().slice(0, 10),
            badgeMeta: kindLabel,
            thumbnailUrl: c.avatarThumb || '',
            thumbTier0Url: c.avatarThumb,
            peerRef: {
              type: c.peerType!,
              id: c.peerId!,
              accessHash: c.accessHash,
            },
            originAccountId: accountId,
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

    /**
     * 将勾选的已解析会话纯本地收藏为 Explore 磁贴（不再次发起 ResolveUsername / CheckChatInvite / JoinChannel 等敏感申领）
     */
    async commitSelectedCandidates() {
      const selected = this.selectedCandidates;
      if (selected.length === 0) {
        this.harvestNotice = '请先勾选至少一条要收藏的群组 / 频道';
        return;
      }
      const chatStore = useChatStore();
      const accountId = chatStore.accountId;
      if (!accountId) {
        this.harvestNotice = 'Telegram 账号已断开，请重新连接后再收藏会话磁贴';
        return;
      }
      this.isCommitting = true;
      this.harvestNotice = null;
      const sessionStore = useSessionManagerStore();
      const tileStore = useTileStore();
      const searchStore = useAggregateSearchStore();
      const targetGroup = tileStore.groups.find((g) => g.id === this.targetExploreGroupId) ?? tileStore.groups[0];
      if (!targetGroup) {
        this.isCommitting = false;
        this.harvestNotice = '未找到目标 Explore 分组';
        return;
      }
      const targetFolder = this.targetExploreFolderId
        ? tileStore.getTileById(this.targetExploreFolderId)
        : undefined;
      const effectiveFolderId =
        targetFolder && targetFolder.type === 'folder' ? targetFolder.id : undefined;

      try {
        let count = 0;
        let skipped = 0;
        const placedTileIds: string[] = [];
        const autoRenew = this.placementMode === 'temp_auto_renew';

        for (const item of selected) {
          if (!item.peerKey || !item.peerId || !item.peerType || !item.peerKind) {
            skipped += 1;
            continue;
          }
          const peerKey = item.peerKey;
          const credState: SessionCredentialState = item.alreadyJoined
            ? 'joined'
            : autoRenew
              ? 'temp_auto_renew'
              : 'temp_ephemeral';
          const hasAvatarSource = Boolean(item.avatarPhotoId && item.avatarDcId);

          const newTile = tileStore.addNewFile(
            {
              title: item.title,
              size: 'medium',
              fileType: 'generic',
              extension: 'tg',
              description: item.about || (item.username ? `@${item.username}` : `来源：${item.sourceTextSnippet}`),
              sourceResultId: peerKey,
              sessionId: peerKey,
              sessionTitle: item.title,
              isSessionLink: true,
              accountId,
              peerKey,
              peerType: item.peerType,
              accessHash: item.accessHash,
              username: item.username,
              inviteHash: item.inviteHash,
              sessionCredentialState: credState,
              peekExpiresAt: item.peekExpiresAt,
              lastVerifiedAt: Date.now(),
              autoRenew,
              participantsCount: item.participantsCount,
              thumb:
                hasAvatarSource || item.avatarThumb
                  ? {
                      status: hasAvatarSource ? 'pending' : 'ready',
                      strippedDataUrl: item.avatarThumb,
                      retryCount: 0,
                      sourceRef: hasAvatarSource
                        ? {
                            accountId,
                            peerId: item.peerId,
                            peerType: item.peerType,
                            accessHash: item.accessHash,
                            photoId: item.avatarPhotoId,
                            dcId: item.avatarDcId,
                          }
                        : undefined,
                    }
                  : { status: 'none', retryCount: 0 },
            },
            targetGroup.id,
            effectiveFolderId,
          );

          if (hasAvatarSource) {
            placedTileIds.push(newTile.id);
          }

          if (!item.alreadyJoined) {
            sessionStore.upsertTempCredential({
              id: `temp-harvest-${peerKey}`,
              peerKey,
              peerId: item.peerId,
              peerType: item.peerType,
              peerKind: item.peerKind,
              accessHash: item.accessHash,
              avatarPhotoId: item.avatarPhotoId,
              avatarDcId: item.avatarDcId,
              avatarThumb: item.avatarThumb,
              title: item.title,
              username: item.username,
              inviteHash: item.inviteHash,
              accountId,
              state: credState,
              autoRenew,
              lastVerifiedAt: Date.now(),
              peekExpiresAt: item.peekExpiresAt ?? Date.now() + 48 * 3600_000,
              participantsCount: item.participantsCount,
              about: item.about,
              linkedTileIds: [newTile.id],
              status: 'healthy',
            });
          }
          count += 1;
        }

        if (placedTileIds.length > 0) {
          tileStore.scheduleTileCoverRefresh(placedTileIds, 'bot_harvest_collect');
        }
        await sessionStore.persistGovernanceToOpfs();

        // 在左栏树中自动展开并高亮目标分组或文件夹
        const highlightId = effectiveFolderId ?? targetGroup.id;
        if (effectiveFolderId && !searchStore.expandedFolderIds.includes(effectiveFolderId)) {
          searchStore.expandedFolderIds.push(effectiveFolderId);
        }
        if (!searchStore.expandedGroupIds.includes(targetGroup.id)) {
          searchStore.expandedGroupIds.push(targetGroup.id);
        }
        searchStore.recentlyImportedTargetId = highlightId;
        window.setTimeout(() => {
          if (searchStore.recentlyImportedTargetId === highlightId) {
            searchStore.recentlyImportedTargetId = null;
          }
        }, 1600);

        const targetLabel =
          targetFolder && targetFolder.type === 'folder'
            ? `${targetGroup.title} / ${targetFolder.title}`
            : targetGroup.title;
        const skippedNotice = skipped > 0 ? `；跳过 ${skipped} 条缺少已确认 peer 凭据的项目` : '';
        this.harvestNotice = `已收藏 ${count} 个群组 / 频道磁贴至「${targetLabel}」${skippedNotice}`;
      } finally {
        this.isCommitting = false;
      }
    },
  },
});
